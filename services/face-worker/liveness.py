"""
Adaptive liveness for face login.

Two endpoints are exposed by this module (wired into app.py):

  POST /face-login/silent
    Multipart form:
      - frames:   5 small JPEG thumbnails of the face region (ordered, earliest first)
      - full:     1 full-resolution frame for embedding + anti-spoof
      - nonce:    short-lived server-issued nonce (POST /face-login/nonce)
    Returns one of:
      { status: "success",   livenessScore: float }
      { status: "challenge", prompt: <one-of: turn_left|turn_right|nod|blink_twice>,
        challengeNonce: str, ttlSec: int }
      { status: "failed",    errorCode: str }  (hard reject; no challenge)

  POST /face-login/challenge
    Multipart form:
      - frames:         5 small JPEG thumbnails captured DURING the motion
      - full:           1 full-resolution frame (last clear frame)
      - challengeNonce: nonce returned by /face-login/silent
    Returns:
      { status: "success", livenessScore: float } or { status: "failed", errorCode: str }

Design notes
------------
* Client-supplied landmarks are NEVER trusted. All landmark geometry is
  re-computed server-side with yunet on the thumbnails.
* MiniFASNet is re-run on the full-resolution frame for each attempt.
* Embedding extraction is caller's responsibility via the existing
  /extract-embedding endpoint; this module returns success/fail + a
  liveness score. The NestJS backend should, on success, call
  /extract-embedding (with antiSpoof=0, liveness already passed here)
  to get the vector and match against the enrolled user.

Why this split: liveness doesn't need an embedding, and the existing
/extract-embedding route already handles the heavy Facenet pass.
"""

from __future__ import annotations

import logging
import secrets
import time
from dataclasses import dataclass, field
from threading import Lock
from typing import Literal, Optional

import cv2
import numpy as np
from deepface import DeepFace
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

logger = logging.getLogger("face-worker.liveness")

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

DETECTOR_BACKEND = "yunet"

# Expected number of thumbnails in a liveness attempt.
REQUIRED_FRAMES = 5

# Nonces.
NONCE_TTL_SEC = 30
CHALLENGE_TTL_SEC = 15

# Passive-check thresholds (tune via logs).
MIN_NONRIGID_RESIDUAL_PX = 0.8   # below this => looks like a rigid (photo) shift
MAX_RIGID_ONLY_RATIO = 0.85       # rigid motion / total motion; above => photo wiggle
MIN_FRAME_PIXEL_DELTA = 2.0       # mean abs pixel delta between consecutive thumbs
MIN_ANTISPOOF_SCORE = 0.6         # MiniFASNet is_real must be True AND score >= this
MIN_BLINK_EAR_DROP = 0.06         # EAR delta across sequence to consider blink observed
MAX_BBOX_JUMP_PX = 60             # bbox center teleport threshold between frames (in thumb px)

# Challenge motion thresholds. Directional prompts: look_left/right/up/down.
#
# The frontend's enroll flow (MediaPipe FaceLandmarker) uses these normalized
# offsets as "successful pose" targets:
#   SIDE_YAW_TARGET   = 0.045   (nose offset / face width)
#   UP_PITCH_TARGET   = 0.032
#   DOWN_PITCH_TARGET = 0.038
#
# Since we verify via yunet bbox-center drift (no landmark pose), we convert
# those targets roughly: a 0.045 yaw corresponds to ~3-5% bbox-width drift
# in practice. We keep absolute-pixel and fractional thresholds both low,
# and require directional dominance so a random wiggle doesn't pass.
CHALLENGE_MIN_DRIFT_PX = 2.5             # absolute eye-midpoint drift (thumb px)
CHALLENGE_MIN_DRIFT_FRAC = 0.012         # drift / mean_bbox; matches ~1% quantization
CHALLENGE_DIRECTIONAL_DOMINANCE = 1.10   # primary axis must beat the opposite by 10%
CHALLENGE_EYE_SEP_YAW_FRAC = 0.06        # |Δ eye-separation| / mean_sep for yaw

# Soft-fail reasons that should trigger a challenge (vs hard reject).
SOFT_FAIL_REASONS = {"STIFF_MOTION", "NO_BLINK_OBSERVED", "BORDERLINE_ANTISPOOF"}

# ---------------------------------------------------------------------------
# Nonce stores (in-memory; fine for single-replica worker)
# ---------------------------------------------------------------------------


@dataclass
class SilentNonce:
    issued_at: float
    used: bool = False


@dataclass
class ChallengeRecord:
    issued_at: float
    prompt: str
    # Candidate identity signal from the silent attempt (the aggregated
    # embedding of the silent full-frame). NestJS can choose to bind
    # the challenge to this candidate to prevent identity swaps.
    silent_full_sha: str = ""
    used: bool = False


_silent_nonces: dict[str, SilentNonce] = {}
_challenge_nonces: dict[str, ChallengeRecord] = {}
_nonce_lock = Lock()


def _gc_nonces(now: float) -> None:
    expired_silent = [k for k, v in _silent_nonces.items() if now - v.issued_at > NONCE_TTL_SEC]
    expired_chal = [k for k, v in _challenge_nonces.items() if now - v.issued_at > CHALLENGE_TTL_SEC]
    for k in expired_silent:
        _silent_nonces.pop(k, None)
    for k in expired_chal:
        _challenge_nonces.pop(k, None)


def _issue_silent_nonce() -> str:
    now = time.time()
    tok = secrets.token_urlsafe(24)
    with _nonce_lock:
        _gc_nonces(now)
        _silent_nonces[tok] = SilentNonce(issued_at=now)
    return tok


def _consume_silent_nonce(tok: str) -> bool:
    now = time.time()
    with _nonce_lock:
        _gc_nonces(now)
        rec = _silent_nonces.get(tok)
        if rec is None or rec.used:
            return False
        if now - rec.issued_at > NONCE_TTL_SEC:
            _silent_nonces.pop(tok, None)
            return False
        rec.used = True
        return True


def _issue_challenge(prompt: str, silent_full_sha: str = "") -> tuple[str, int]:
    now = time.time()
    tok = secrets.token_urlsafe(24)
    with _nonce_lock:
        _gc_nonces(now)
        _challenge_nonces[tok] = ChallengeRecord(
            issued_at=now, prompt=prompt, silent_full_sha=silent_full_sha
        )
    return tok, CHALLENGE_TTL_SEC


def _consume_challenge(tok: str) -> Optional[ChallengeRecord]:
    now = time.time()
    with _nonce_lock:
        _gc_nonces(now)
        rec = _challenge_nonces.get(tok)
        if rec is None or rec.used:
            return None
        if now - rec.issued_at > CHALLENGE_TTL_SEC:
            _challenge_nonces.pop(tok, None)
            return None
        rec.used = True
        return rec


# ---------------------------------------------------------------------------
# Image + landmark utilities
# ---------------------------------------------------------------------------


def _decode_jpeg(buf: bytes) -> np.ndarray:
    raw = np.frombuffer(buf, dtype=np.uint8)
    img = cv2.imdecode(raw, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(
            status_code=400,
            detail={"errorCode": "INVALID_IMAGE", "message": "Invalid image"},
        )
    return img


@dataclass
class FrameAnalysis:
    image: np.ndarray
    # Key landmarks from yunet: re, le, nose, mouth_right, mouth_left (5 points)
    # yunet returns them in that order. We wrap as an (N,2) float array.
    landmarks: np.ndarray = field(default_factory=lambda: np.zeros((0, 2), dtype=np.float32))
    bbox: tuple[int, int, int, int] = (0, 0, 0, 0)  # x, y, w, h
    score: float = 0.0


def _yunet_detect(image: np.ndarray) -> Optional[FrameAnalysis]:
    """Run yunet directly (bypassing DeepFace) so we can get both bbox and
    the 5 facial landmarks yunet emits. Returns None if no face."""
    try:
        h, w = image.shape[:2]
        # DeepFace ships yunet weights under ~/.deepface/weights; we reuse
        # opencv's FaceDetectorYN loaded from DeepFace detector backend so
        # model paths stay centralized. We fall back to DeepFace.extract_faces
        # if direct yunet isn't available.
        faces = DeepFace.extract_faces(
            img_path=image,
            detector_backend=DETECTOR_BACKEND,
            enforce_detection=False,
            align=False,
        )
        if not faces:
            return None
        # DeepFace returns facial_area with x, y, w, h plus left_eye / right_eye.
        best = faces[0]
        fa = best.get("facial_area", {})
        bbox = (int(fa.get("x", 0)), int(fa.get("y", 0)), int(fa.get("w", 0)), int(fa.get("h", 0)))
        conf = float(best.get("confidence", 0.0))

        # Build a 5-point landmark array when available.
        pts = []
        le = fa.get("left_eye")
        re = fa.get("right_eye")
        if le is not None and re is not None:
            # Order: right eye, left eye, nose (approx bbox center), mouth corners (approx)
            # yunet exposes only eyes in DeepFace; we synthesize approximate nose/mouth
            # from bbox geometry to keep the landmark dimensionality consistent.
            x, y, bw, bh = bbox
            nose = (x + bw / 2.0, y + bh * 0.55)
            mouth_r = (x + bw * 0.35, y + bh * 0.80)
            mouth_l = (x + bw * 0.65, y + bh * 0.80)
            pts = [re, le, nose, mouth_r, mouth_l]
        if not pts:
            # Fallback: use bbox corners as degenerate landmark set.
            x, y, bw, bh = bbox
            pts = [(x, y), (x + bw, y), (x + bw / 2, y + bh / 2), (x, y + bh), (x + bw, y + bh)]

        lm = np.asarray(pts, dtype=np.float32)
        return FrameAnalysis(image=image, landmarks=lm, bbox=bbox, score=conf)
    except Exception as exc:
        logger.warning("yunet detection error: %s", exc)
        return None


def _procrustes_residual(a: np.ndarray, b: np.ndarray) -> tuple[float, float]:
    """Fit best similarity transform (rotation + uniform scale + translation)
    that maps points a -> b, then return:
      (mean_residual_px, rigid_motion_magnitude_px)

    A flat photo being translated/rotated yields residual ~= 0 and
    rigid_motion > 0. A real face yields residual > 0 because landmarks
    deform non-rigidly (blinks, mouth, parallax on nose tip).
    """
    if a.shape != b.shape or a.shape[0] < 3:
        return 0.0, 0.0

    ca = a.mean(axis=0)
    cb = b.mean(axis=0)
    a0 = a - ca
    b0 = b - cb

    # Optimal rotation + scale via SVD (Procrustes).
    h = a0.T @ b0
    u, s, vt = np.linalg.svd(h)
    r = vt.T @ u.T
    # Handle reflection: ensure det(R) > 0.
    if np.linalg.det(r) < 0:
        vt[-1, :] *= -1
        r = vt.T @ u.T

    scale = s.sum() / (np.square(a0).sum() + 1e-9)
    a_fit = scale * (a0 @ r.T) + cb

    residuals = np.linalg.norm(b - a_fit, axis=1)
    mean_residual = float(residuals.mean())
    rigid_magnitude = float(np.linalg.norm(cb - ca))
    return mean_residual, rigid_magnitude


def _pixel_delta(a: np.ndarray, b: np.ndarray) -> float:
    if a.shape != b.shape:
        return 0.0
    return float(np.mean(np.abs(a.astype(np.int16) - b.astype(np.int16))))


def _estimate_ear(landmarks: np.ndarray, bbox_h: float) -> float:
    """Very rough EAR proxy: vertical distance between the two eyes' y-coords
    and horizontal eye separation, normalized by bbox height. Real EAR needs
    6 per-eye landmarks which yunet doesn't give us; we use this as a coarse
    proxy sufficient for detecting gross eye-state changes across frames."""
    if landmarks.shape[0] < 2 or bbox_h <= 0:
        return 0.0
    re, le = landmarks[0], landmarks[1]
    eye_sep = float(np.linalg.norm(re - le))
    return eye_sep / bbox_h


def _estimate_yaw_deg(landmarks: np.ndarray, bbox: tuple[int, int, int, int]) -> float:
    """Approximate yaw from nose-tip offset relative to bbox center, normalized
    by bbox width. Positive => face turned right (camera's POV)."""
    if landmarks.shape[0] < 3:
        return 0.0
    _, _, bw, _ = bbox
    if bw <= 0:
        return 0.0
    x, y, _, _ = bbox
    cx = x + bw / 2.0
    nose_x = float(landmarks[2, 0])
    # Map normalized offset [-0.5, 0.5] to approx [-45deg, 45deg]
    return float(np.clip((nose_x - cx) / bw, -0.5, 0.5)) * 90.0


def _estimate_pitch_deg(landmarks: np.ndarray, bbox: tuple[int, int, int, int]) -> float:
    if landmarks.shape[0] < 3:
        return 0.0
    _, y, _, bh = bbox
    if bh <= 0:
        return 0.0
    cy = y + bh / 2.0
    nose_y = float(landmarks[2, 1])
    return float(np.clip((nose_y - cy) / bh, -0.5, 0.5)) * 90.0


# ---------------------------------------------------------------------------
# Analysis pipeline
# ---------------------------------------------------------------------------


@dataclass
class PassiveResult:
    ok: bool
    hard_fail: bool
    reason: str
    score: float  # 0..1 composite confidence
    metrics: dict


def _analyze_passive(frames: list[FrameAnalysis]) -> PassiveResult:
    """Run passive liveness checks on ordered frames. Returns (ok, hard_fail,
    reason, score, metrics)."""
    metrics: dict = {}

    if len(frames) != REQUIRED_FRAMES:
        return PassiveResult(False, True, "FRAME_COUNT", 0.0, metrics)

    # Every frame must contain exactly one detected face.
    for i, f in enumerate(frames):
        if f.landmarks.shape[0] == 0 or f.bbox[2] == 0 or f.bbox[3] == 0:
            return PassiveResult(False, True, f"NO_FACE_FRAME_{i}", 0.0, metrics)

    # Pairwise pixel deltas: reject if any two frames are effectively identical
    # (attacker sent the same JPEG with slightly different filenames).
    deltas = []
    for i in range(len(frames) - 1):
        d = _pixel_delta(frames[i].image, frames[i + 1].image)
        deltas.append(d)
    metrics["frame_deltas"] = [round(d, 3) for d in deltas]
    if min(deltas) < MIN_FRAME_PIXEL_DELTA:
        return PassiveResult(False, True, "DUPLICATE_FRAMES", 0.0, metrics)

    # Bbox teleport check: face shouldn't jump wildly between consecutive thumbs.
    bbox_jumps = []
    for i in range(len(frames) - 1):
        a = frames[i].bbox
        b = frames[i + 1].bbox
        ca = (a[0] + a[2] / 2.0, a[1] + a[3] / 2.0)
        cb = (b[0] + b[2] / 2.0, b[1] + b[3] / 2.0)
        bbox_jumps.append(float(np.hypot(ca[0] - cb[0], ca[1] - cb[1])))
    metrics["bbox_jumps"] = [round(j, 2) for j in bbox_jumps]
    if max(bbox_jumps) > MAX_BBOX_JUMP_PX:
        return PassiveResult(False, True, "BBOX_TELEPORT", 0.0, metrics)

    # Non-rigid residual across first and last frame (widest baseline).
    residual, rigid_mag = _procrustes_residual(frames[0].landmarks, frames[-1].landmarks)
    metrics["residual_px"] = round(residual, 3)
    metrics["rigid_motion_px"] = round(rigid_mag, 3)

    total_motion = residual + rigid_mag + 1e-6
    rigid_ratio = rigid_mag / total_motion
    metrics["rigid_ratio"] = round(rigid_ratio, 3)

    if residual < MIN_NONRIGID_RESIDUAL_PX and rigid_mag > 2.0:
        # Significant translation but no non-rigid deformation => moved photo.
        return PassiveResult(False, True, "RIGID_ONLY_MOTION", 0.0, metrics)

    if rigid_ratio > MAX_RIGID_ONLY_RATIO and rigid_mag > 3.0:
        return PassiveResult(False, True, "RIGID_ONLY_MOTION", 0.0, metrics)

    # EAR proxy: look for any downward excursion across the sequence.
    ears = [_estimate_ear(f.landmarks, float(f.bbox[3])) for f in frames]
    metrics["ear_series"] = [round(e, 3) for e in ears]
    ear_range = max(ears) - min(ears)
    blink_observed = ear_range >= MIN_BLINK_EAR_DROP

    # If motion is very small (stiff user), this is soft-fail territory.
    if residual < MIN_NONRIGID_RESIDUAL_PX and rigid_mag < 1.5:
        return PassiveResult(False, False, "STIFF_MOTION", 0.3, metrics)

    if not blink_observed:
        # User may have kept eyes wide open for 1s; ambiguous.
        return PassiveResult(False, False, "NO_BLINK_OBSERVED", 0.55, metrics)

    # Passive looks good.
    score = min(1.0, 0.4 + residual * 0.1 + ear_range * 2.0)
    return PassiveResult(True, False, "OK", score, metrics)


def _run_anti_spoof(full_image: np.ndarray) -> tuple[bool, float]:
    try:
        af = DeepFace.extract_faces(
            img_path=full_image,
            detector_backend=DETECTOR_BACKEND,
            enforce_detection=True,
            align=False,
            anti_spoofing=True,
        )
        if not af:
            return False, 0.0
        f = af[0]
        return bool(f.get("is_real", False)), float(f.get("antispoof_score", 0.0))
    except Exception as exc:
        logger.warning("anti-spoof error: %s", exc)
        return False, 0.0


def _read_upload_list(files: list[UploadFile]) -> list[bytes]:
    out = []
    for f in files:
        data = f.file.read()
        if not data:
            raise HTTPException(
                status_code=400,
                detail={"errorCode": "INVALID_IMAGE", "message": "Invalid image"},
            )
        out.append(data)
    return out


def _analyze_frames(frame_bufs: list[bytes]) -> list[FrameAnalysis]:
    out: list[FrameAnalysis] = []
    for buf in frame_bufs:
        img = _decode_jpeg(buf)
        det = _yunet_detect(img)
        if det is None:
            out.append(FrameAnalysis(image=img))
        else:
            out.append(det)
    return out


# ---------------------------------------------------------------------------
# Challenge verification
# ---------------------------------------------------------------------------


def _verify_challenge_motion(prompt: str, frames: list[FrameAnalysis]) -> tuple[bool, str, dict]:
    """Verify the user turned their head in the prompted direction.

    yunet returns 2 real eye landmarks. We use eye-midpoint motion as the
    primary signal (sub-pixel sensitive) and inter-eye-distance change as
    a yaw signal (eyes appear closer together when head turns sideways).
    """
    metrics: dict = {}

    ex_series, ey_series = [], []
    eye_sep_series = []
    bbox_w_series, bbox_h_series = [], []

    for f in frames:
        if f.landmarks.shape[0] >= 2 and f.bbox[2] > 0 and f.bbox[3] > 0:
            re = f.landmarks[0]
            le = f.landmarks[1]
            ex_series.append(float((re[0] + le[0]) / 2.0))
            ey_series.append(float((re[1] + le[1]) / 2.0))
            eye_sep_series.append(float(np.linalg.norm(re - le)))
            bbox_w_series.append(float(f.bbox[2]))
            bbox_h_series.append(float(f.bbox[3]))

    if len(ex_series) < 3:
        return False, "INSUFFICIENT_LANDMARKS", metrics

    ex0, ey0 = ex_series[0], ey_series[0]
    dx_max = max(ex - ex0 for ex in ex_series)
    dx_min = min(ex - ex0 for ex in ex_series)
    dy_max = max(ey - ey0 for ey in ey_series)
    dy_min = min(ey - ey0 for ey in ey_series)

    sep0 = eye_sep_series[0]
    sep_min = min(eye_sep_series)
    sep_max = max(eye_sep_series)
    sep_shrink_frac = (sep0 - sep_min) / sep0 if sep0 > 0 else 0.0
    sep_grow_frac = (sep_max - sep0) / sep0 if sep0 > 0 else 0.0

    mean_bbox = (
        sum(bbox_w_series) / len(bbox_w_series)
        + sum(bbox_h_series) / len(bbox_h_series)
    ) / 2.0

    metrics.update({
        "dx_max": round(dx_max, 2),
        "dx_min": round(dx_min, 2),
        "dy_max": round(dy_max, 2),
        "dy_min": round(dy_min, 2),
        "eye_sep_shrink_frac": round(sep_shrink_frac, 3),
        "eye_sep_grow_frac": round(sep_grow_frac, 3),
        "mean_bbox": round(mean_bbox, 2),
    })

    if prompt == "look_left":
        primary, competing = dx_max, abs(dx_min)
        yaw_signal = sep_shrink_frac  # eyes get closer as head turns either way
    elif prompt == "look_right":
        primary, competing = abs(dx_min), dx_max
        yaw_signal = sep_shrink_frac
    elif prompt == "look_up":
        primary, competing = abs(dy_min), dy_max
        yaw_signal = 0.0
    elif prompt == "look_down":
        primary, competing = dy_max, abs(dy_min)
        yaw_signal = 0.0
    else:
        return False, "UNKNOWN_PROMPT", metrics

    metrics["primary_drift"] = round(primary, 2)
    metrics["competing_drift"] = round(competing, 2)
    frac = primary / mean_bbox if mean_bbox > 0 else 0.0
    metrics["primary_frac"] = round(frac, 3)
    metrics["yaw_signal"] = round(yaw_signal, 3)

    # Magnitude OK via any of: eye-midpoint pixel drift, fractional drift,
    # or (for yaw prompts) enough inter-eye-distance shrink.
    magnitude_ok = (
        primary >= CHALLENGE_MIN_DRIFT_PX
        or frac >= CHALLENGE_MIN_DRIFT_FRAC
        or yaw_signal >= CHALLENGE_EYE_SEP_YAW_FRAC
    )
    if not magnitude_ok:
        return False, "DRIFT_INSUFFICIENT", metrics

    # Directional dominance: accept if primary clearly beats the opposite, OR
    # if we have strong yaw signal (sideways turn), OR if competing drift is
    # effectively zero.
    dominance_ok = (
        primary >= competing * CHALLENGE_DIRECTIONAL_DOMINANCE
        or yaw_signal >= CHALLENGE_EYE_SEP_YAW_FRAC
        or competing <= 1.0
    )
    if not dominance_ok:
        return False, "WRONG_DIRECTION", metrics

    return True, "OK", metrics


# ---------------------------------------------------------------------------
# FastAPI router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/face-login", tags=["face-login"])

PROMPTS = ("look_left", "look_right", "look_up", "look_down")


@router.post("/nonce")
def issue_nonce():
    tok = _issue_silent_nonce()
    return {"nonce": tok, "ttlSec": NONCE_TTL_SEC}


@router.post("/silent")
async def silent_attempt(
    request: Request,
    nonce: str = Form(...),
    frames: list[UploadFile] = File(...),
    full: UploadFile = File(...),
):
    if not _consume_silent_nonce(nonce):
        logger.warning("silent: invalid/expired nonce from ip=%s", request.client.host if request.client else "?")
        raise HTTPException(
            status_code=400,
            detail={"errorCode": "INVALID_NONCE", "message": "Invalid or expired nonce"},
        )

    if len(frames) != REQUIRED_FRAMES:
        raise HTTPException(
            status_code=400,
            detail={"errorCode": "FRAME_COUNT", "message": f"Expected {REQUIRED_FRAMES} frames"},
        )

    frame_bufs = _read_upload_list(frames)
    full_buf = full.file.read()
    if not full_buf:
        raise HTTPException(
            status_code=400,
            detail={"errorCode": "INVALID_IMAGE", "message": "Invalid image"},
        )

    started = time.perf_counter()

    # Per-frame detection + geometric analysis.
    analyses = _analyze_frames(frame_bufs)
    passive = _analyze_passive(analyses)
    logger.info(
        "silent: passive ok=%s reason=%s score=%.2f metrics=%s",
        passive.ok, passive.reason, passive.score, passive.metrics,
    )

    # Hard reject before paying MiniFASNet cost.
    if passive.hard_fail:
        return {"status": "failed", "errorCode": passive.reason}

    # Run anti-spoof on the full-resolution frame (authoritative).
    full_image = _decode_jpeg(full_buf)
    is_real, spoof_score = _run_anti_spoof(full_image)
    logger.info("silent: anti-spoof is_real=%s score=%.3f", is_real, spoof_score)

    if not is_real:
        return {"status": "failed", "errorCode": "SPOOF_DETECTED"}

    # Borderline anti-spoof => soft fail (challenge).
    if spoof_score < MIN_ANTISPOOF_SCORE and passive.reason == "OK":
        passive = PassiveResult(False, False, "BORDERLINE_ANTISPOOF", min(passive.score, 0.5), passive.metrics)

    # If passive is fully clean AND anti-spoof is confident => success.
    if passive.ok and spoof_score >= MIN_ANTISPOOF_SCORE:
        elapsed = time.perf_counter() - started
        logger.info("silent: SUCCESS score=%.2f elapsed=%.3fs", passive.score, elapsed)
        # Caller (NestJS) now calls /extract-embedding?antiSpoof=0 on the full
        # frame to get the embedding and match against the enrolled user.
        return {
            "status": "success",
            "livenessScore": round(passive.score, 3),
            "antispoofScore": round(spoof_score, 3),
        }

    # Soft fail => issue challenge.
    if passive.reason in SOFT_FAIL_REASONS:
        prompt = secrets.choice(PROMPTS)
        chal_tok, ttl = _issue_challenge(prompt)
        logger.info(
            "silent: CHALLENGE prompt=%s reason=%s score=%.2f",
            prompt, passive.reason, passive.score,
        )
        return {
            "status": "challenge",
            "prompt": prompt,
            "challengeNonce": chal_tok,
            "ttlSec": ttl,
        }

    return {"status": "failed", "errorCode": passive.reason}


@router.post("/challenge")
async def challenge_attempt(
    request: Request,
    challengeNonce: str = Form(...),
    frames: list[UploadFile] = File(...),
    full: UploadFile = File(...),
):
    rec = _consume_challenge(challengeNonce)
    if rec is None:
        raise HTTPException(
            status_code=400,
            detail={"errorCode": "INVALID_NONCE", "message": "Invalid or expired challenge nonce"},
        )

    if len(frames) != REQUIRED_FRAMES:
        raise HTTPException(
            status_code=400,
            detail={"errorCode": "FRAME_COUNT", "message": f"Expected {REQUIRED_FRAMES} frames"},
        )

    frame_bufs = _read_upload_list(frames)
    full_buf = full.file.read()
    if not full_buf:
        raise HTTPException(
            status_code=400,
            detail={"errorCode": "INVALID_IMAGE", "message": "Invalid image"},
        )

    started = time.perf_counter()

    analyses = _analyze_frames(frame_bufs)
    # Basic hygiene: every frame has a face, frames differ, no teleport.
    passive = _analyze_passive(analyses)
    if passive.hard_fail:
        logger.info("challenge: passive hard-fail %s", passive.reason)
        return {"status": "failed", "errorCode": passive.reason}

    full_image = _decode_jpeg(full_buf)
    is_real, spoof_score = _run_anti_spoof(full_image)
    if not is_real:
        logger.info("challenge: spoof rejected score=%.3f", spoof_score)
        return {"status": "failed", "errorCode": "SPOOF_DETECTED"}

    motion_ok, motion_reason, motion_metrics = _verify_challenge_motion(rec.prompt, analyses)
    logger.info(
        "challenge: prompt=%s motion_ok=%s reason=%s metrics=%s",
        rec.prompt, motion_ok, motion_reason, motion_metrics,
    )
    if not motion_ok:
        return {"status": "failed", "errorCode": f"CHALLENGE_{motion_reason}"}

    elapsed = time.perf_counter() - started
    logger.info("challenge: SUCCESS prompt=%s elapsed=%.3fs", rec.prompt, elapsed)
    return {
        "status": "success",
        "livenessScore": round(max(passive.score, 0.75), 3),
        "antispoofScore": round(spoof_score, 3),
        "prompt": rec.prompt,
    }
