from __future__ import annotations

from contextlib import asynccontextmanager
from fastapi import FastAPI, File, HTTPException, UploadFile
from deepface import DeepFace
import cv2
import numpy as np

MODEL_NAME = "Facenet"
DETECTOR_BACKEND = "retinaface"


def _warm_up_models() -> None:
    # Recognition model used to generate embeddings.
    DeepFace.build_model(model_name=MODEL_NAME)

    # Run one synthetic pass so TensorFlow and the detector graph are initialized
    # before the first real request hits the worker.
    dummy_image = np.zeros((224, 224, 3), dtype=np.uint8)

    try:
        DeepFace.extract_faces(
            img_path=dummy_image,
            detector_backend=DETECTOR_BACKEND,
            enforce_detection=False,
            align=True,
        )

        DeepFace.represent(
            img_path=dummy_image,
            model_name=MODEL_NAME,
            detector_backend=DETECTOR_BACKEND,
            enforce_detection=False,
            align=True,
        )
    finally:
        del dummy_image


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Preload the recognition model, detector model, and runtime graph so the
    # first real request does not pay the heavy initialization cost.
    _warm_up_models()
    app.state.model_ready = True
    yield


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


@app.get("/health")
def health():
    return {
        "success": True,
        "message": "ok",
        "modelReady": bool(getattr(app.state, "model_ready", False)),
        "modelName": MODEL_NAME,
    }


@app.post("/extract-embedding")
async def extract_embedding(image: UploadFile = File(...)):
    contents = await image.read()
    if not contents:
        raise HTTPException(
            status_code=400,
            detail={
                "errorCode": "INVALID_IMAGE",
                "message": "Invalid image",
            },
        )

    decoded_image = _decode_image(contents)

    try:
        faces = DeepFace.extract_faces(
            img_path=decoded_image,
            detector_backend=DETECTOR_BACKEND,
            enforce_detection=True,
            align=True,
        )

        if len(faces) != 1:
            error_code = (
                "MULTIPLE_FACES_DETECTED" if len(faces) > 1 else "NO_FACE_DETECTED"
            )
            message = "Multiple faces detected" if len(faces) > 1 else "No face detected"
            raise HTTPException(
                status_code=400,
                detail={
                    "errorCode": error_code,
                    "message": message,
                },
            )

        embeddings = DeepFace.represent(
            img_path=decoded_image,
            model_name=MODEL_NAME,
            detector_backend=DETECTOR_BACKEND,
            enforce_detection=True,
            align=True,
        )

        if not embeddings:
            raise HTTPException(
                status_code=400,
                detail={
                    "errorCode": "NO_FACE_DETECTED",
                    "message": "No face detected",
                },
            )

        embedding = embeddings[0].get("embedding")
        if not embedding:
            raise HTTPException(
                status_code=500,
                detail={
                    "errorCode": "WORKER_INTERNAL_ERROR",
                    "message": "Face worker error",
                },
            )

        normalized_embedding = _normalize_embedding(embedding)

        return {
            "embedding": normalized_embedding,
            "dimension": len(normalized_embedding),
        }
    except HTTPException:
        raise
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail={
                "errorCode": "NO_FACE_DETECTED",
                "message": "No face detected",
            },
        )
    except Exception:
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
