import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
} from "@nestjs/common";
import { UploadedImageFile } from "./types/uploaded-image-file.type";

type WorkerSuccessResponse = {
  embedding?: number[];
  dimension?: number;
};

type WorkerErrorPayload = {
  errorCode?: string;
  message?: string;
};

@Injectable()
export class FaceIdWorkerClient {
  private readonly workerUrl =
    process.env.FACE_WORKER_URL?.trim() || "http://localhost:8000";
  private readonly timeoutMs = Number(process.env.FACE_WORKER_TIMEOUT_MS ?? 15000);

  async extractEmbedding(file: UploadedImageFile) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const formData = new FormData();
      const imageBytes = new Uint8Array(file.buffer);
      formData.append(
        "image",
        new Blob([imageBytes], { type: file.mimetype }),
        file.originalname || "face-image.jpg",
      );

      const response = await fetch(`${this.workerUrl}/extract-embedding`, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => null)) as
        | WorkerSuccessResponse
        | { detail?: WorkerErrorPayload | string }
        | null;

      if (!response.ok) {
        this.throwWorkerError(payload);
      }

      const successPayload = payload as WorkerSuccessResponse | null;
      const embedding = Array.isArray(successPayload?.embedding)
        ? successPayload.embedding
        : null;
      const dimension = successPayload?.dimension;

      if (!embedding || embedding.length === 0 || typeof dimension !== "number") {
        throw new BadGatewayException({
          success: false,
          message: "Invalid response from face worker",
          errorCode: "WORKER_INTERNAL_ERROR",
        });
      }

      return { embedding, dimension };
    } catch (error) {
      if (
        error instanceof GatewayTimeoutException ||
        error instanceof BadRequestException ||
        error instanceof BadGatewayException
      ) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new GatewayTimeoutException({
          success: false,
          message: "Face worker timeout",
          errorCode: "WORKER_TIMEOUT",
        });
      }

      throw new BadGatewayException({
        success: false,
        message: "Unable to reach face worker",
        errorCode: "WORKER_INTERNAL_ERROR",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private throwWorkerError(
    payload:
      | WorkerSuccessResponse
      | { detail?: WorkerErrorPayload | string }
      | null,
  ): never {
    const detail = payload && "detail" in payload ? payload.detail : undefined;

    if (detail && typeof detail === "object") {
      const message = detail.message ?? "Face worker error";
      const errorCode = detail.errorCode ?? "WORKER_INTERNAL_ERROR";

      if (errorCode === "WORKER_TIMEOUT") {
        throw new GatewayTimeoutException({
          success: false,
          message,
          errorCode,
        });
      }

      throw new BadRequestException({
        success: false,
        message,
        errorCode,
      });
    }

    if (typeof detail === "string" && detail.trim().length > 0) {
      throw new BadRequestException({
        success: false,
        message: detail,
        errorCode: "WORKER_INTERNAL_ERROR",
      });
    }

    throw new BadGatewayException({
      success: false,
      message: "Face worker error",
      errorCode: "WORKER_INTERNAL_ERROR",
    });
  }
}
