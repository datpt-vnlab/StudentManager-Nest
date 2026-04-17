from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from itertools import count
from threading import Lock

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from deepface import DeepFace
import cv2
import numpy as np

MODEL_NAME = "Facenet"
DETECTOR_BACKEND = "yunet"  # fast + accurate; was "retinaface"
EXPECTED_EMBEDDING_DIM = 128  # Facenet => 128; Facenet512 => 512
HEARTBEAT_INTERVAL_SEC = 60

# Downscale input so we don't run detection on 12MP phone photos.
# Longest edge is clamped to this value; smaller images are left untouched.
MAX_INPUT_EDGE_PX = 800

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("face-worker")

# Request counter: total received / currently in-flight
_request_counter = count(1)
_in_flight_lock = Lock()
_in_flight = 0


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _warm_up_models() -> None:
    logger.info(
        "Warming up models (model=%s, detector=%s)", MODEL_NAME, DETECTOR_BACKEND
    )
    started = time.perf_counter()
    # Recognition model used to generate embeddings.
    DeepFace.build_model(model_name=MODEL_NAME)

    # Run one synthetic pass so TensorFlow and the detector graph are initialized
    # before the first real request hits the worker.
    dummy_image = np.zeros((224, 224, 3), dtype=np.uint8)

    try:
        # Single warm pass using the same represent() path the request uses.
        reps = DeepFace.represent(
            img_path=dummy_image,
            model_name=MODEL_NAME,
            detector_backend=DETECTOR_BACKEND,
            enforce_detection=False,
            align=True,
        )
        # Verify embedding dimension matches expectation.
        dim = len(reps[0].get("embedding", [])) if reps else 0
        if dim != EXPECTED_EMBEDDING_DIM:
            raise RuntimeError(
                f"Unexpected embedding dimension: got {dim}, expected "
                f"{EXPECTED_EMBEDDING_DIM} (model={MODEL_NAME})"
            )
        logger.info(
            "Embedding dimension verified: %d (model=%s)", dim, MODEL_NAME
        )
    finally:
        del dummy_image
    logger.info(
        "Model warm-up complete in %.2fs", time.perf_counter() - started
    )


async def _heartbeat_loop() -> None:
    """Emit a periodic log line so we can see in `docker logs` whether the
    event loop is alive and the worker is still responsive while idle."""
    while True:
        try:
            await asyncio.sleep(HEARTBEAT_INTERVAL_SEC)
            with _in_flight_lock:
                active = _in_flight
            logger.info(
                "heartbeat: alive in_flight=%d total_seen=%d",
                active,
                # peek next id without consuming: use a surrogate
                # (count has no peek, so just show an approximation via active)
                active,
            )
        except asyncio.CancelledError:
            logger.info("heartbeat loop cancelled")
            raise
        except Exception as exc:  # pragma: no cover
            logger.exception("heartbeat error: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Preload the recognition model, detector model, and runtime graph so the
    # first real request does not pay the heavy initialization cost.
    _warm_up_models()
    app.state.model_ready = True
    app.state.embedding_dim = EXPECTED_EMBEDDING_DIM
    logger.info("Face worker ready to accept requests")
    hb_task = asyncio.create_task(_heartbeat_loop())
    try:
        yield
    finally:
        hb_task.cancel()
        try:
            await hb_task
        except (asyncio.CancelledError, Exception):
            pass


app = FastAPI(lifespan=lifespan)
app.state.model_ready = False


def _normalize_embedding(embedding: list[float]) -> list[float]:
    vector = np.array(embedding, dtype=np.float32)
    norm = np.linalg.norm(vector)

    if not np.isfinite(norm) or norm == 0:
        raise HTTPException(
            status_code=400,
            detail={
                "errorCode": "INVALID_IMAGE",
                "message": "Invalid image",
            },
        )

    normalized = vector / norm
    return normalized.astype(float).tolist()


def _decode_image(contents: bytes) -> np.ndarray:
    raw = np.frombuffer(contents, dtype=np.uint8)
    image = cv2.imdecode(raw, cv2.IMREAD_COLOR)

    if image is None:
        raise HTTPException(
            status_code=400,
            detail={
                "errorCode": "INVALID_IMAGE",
                "message": "Invalid image",
            },
        )

    return image


def _downscale_if_needed(image: np.ndarray) -> tuple[np.ndarray, float]:
    """Clamp the longest edge to MAX_INPUT_EDGE_PX. Returns (image, scale).
    scale < 1.0 means the image was downscaled.
    """
    h, w = image.shape[:2]
    longest = max(h, w)
    if longest <= MAX_INPUT_EDGE_PX:
        return image, 1.0
    scale = MAX_INPUT_EDGE_PX / float(longest)
    new_w = int(round(w * scale))
    new_h = int(round(h * scale))
    resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return resized, scale


@app.get("/health")
def health():
    return {
        "success": True,
        "message": "ok",
        "modelReady": bool(getattr(app.state, "model_ready", False)),
        "modelName": MODEL_NAME,
        "embeddingDim": getattr(app.state, "embedding_dim", EXPECTED_EMBEDDING_DIM),
    }


@app.post("/extract-embedding")
async def extract_embedding(request: Request, image: UploadFile = File(...)):
    global _in_flight
    req_id = next(_request_counter)
    ip = _client_ip(request)

    with _in_flight_lock:
        _in_flight += 1
        active = _in_flight

    logger.info(
        "[req #%d] Processing %d/%d from ip=%s filename=%s content_type=%s",
        req_id,
        active,
        req_id,
        ip,
        image.filename,
        image.content_type,
    )
    started = time.perf_counter()

    try:
        contents = await image.read()
        if not contents:
            logger.warning(
                "[req #%d] Empty upload from ip=%s", req_id, ip
            )
            raise HTTPException(
                status_code=400,
                detail={
                    "errorCode": "INVALID_IMAGE",
                    "message": "Invalid image",
                },
            )

        logger.info(
            "[req #%d] Received %d bytes from ip=%s", req_id, len(contents), ip
        )
        decoded_image = _decode_image(contents)
        orig_shape = decoded_image.shape
        decoded_image, scale = _downscale_if_needed(decoded_image)
        if scale < 1.0:
            logger.info(
                "[req #%d] Downscaled %s -> %s (scale=%.3f) ip=%s",
                req_id,
                orig_shape,
                decoded_image.shape,
                scale,
                ip,
            )
        else:
            logger.info(
                "[req #%d] Decoded image shape=%s from ip=%s",
                req_id,
                decoded_image.shape,
                ip,
            )

        try:
            # Single pass: represent() runs detection + alignment + embedding
            # internally. Avoids the double-detect we were doing before.
            embeddings = DeepFace.represent(
                img_path=decoded_image,
                model_name=MODEL_NAME,
                detector_backend=DETECTOR_BACKEND,
                enforce_detection=True,
                align=True,
            )
            face_count = len(embeddings) if embeddings else 0
            logger.info(
                "[req #%d] Detected %d face(s) from ip=%s", req_id, face_count, ip
            )

            if face_count != 1:
                error_code = (
                    "MULTIPLE_FACES_DETECTED" if face_count > 1 else "NO_FACE_DETECTED"
                )
                message = (
                    "Multiple faces detected" if face_count > 1 else "No face detected"
                )
                logger.warning(
                    "[req #%d] %s from ip=%s (faces=%d)",
                    req_id,
                    error_code,
                    ip,
                    face_count,
                )
                raise HTTPException(
                    status_code=400,
                    detail={
                        "errorCode": error_code,
                        "message": message,
                    },
                )

            embedding = embeddings[0].get("embedding")
            if not embedding:
                logger.error(
                    "[req #%d] Empty embedding vector from ip=%s", req_id, ip
                )
                raise HTTPException(
                    status_code=500,
                    detail={
                        "errorCode": "WORKER_INTERNAL_ERROR",
                        "message": "Face worker error",
                    },
                )

            normalized_embedding = _normalize_embedding(embedding)
            if len(normalized_embedding) != EXPECTED_EMBEDDING_DIM:
                logger.error(
                    "[req #%d] Embedding dim mismatch: got=%d expected=%d ip=%s",
                    req_id,
                    len(normalized_embedding),
                    EXPECTED_EMBEDDING_DIM,
                    ip,
                )
                raise HTTPException(
                    status_code=500,
                    detail={
                        "errorCode": "WORKER_INTERNAL_ERROR",
                        "message": "Face worker error",
                    },
                )
            elapsed = time.perf_counter() - started
            logger.info(
                "[req #%d] OK dim=%d elapsed=%.3fs ip=%s",
                req_id,
                len(normalized_embedding),
                elapsed,
                ip,
            )

            return {
                "embedding": normalized_embedding,
                "dimension": len(normalized_embedding),
            }
        except HTTPException:
            raise
        except ValueError:
            logger.warning(
                "[req #%d] ValueError (no face) from ip=%s", req_id, ip
            )
            raise HTTPException(
                status_code=400,
                detail={
                    "errorCode": "NO_FACE_DETECTED",
                    "message": "No face detected",
                },
            )
        except Exception as exc:
            logger.exception(
                "[req #%d] Unexpected error from ip=%s: %s", req_id, ip, exc
            )
            raise HTTPException(
                status_code=500,
                detail={
                    "errorCode": "WORKER_INTERNAL_ERROR",
                    "message": "Face worker error",
                },
            )
        finally:
            del contents
            del decoded_image
    finally:
        with _in_flight_lock:
            _in_flight -= 1
        logger.info(
            "[req #%d] Done in %.3fs ip=%s (in_flight=%d)",
            req_id,
            time.perf_counter() - started,
            ip,
            _in_flight,
        )
