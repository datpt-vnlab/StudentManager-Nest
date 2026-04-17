import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { FaceIdWorkerClient } from "./face-id.worker-client";
import { UploadedImageFile } from "./types/uploaded-image-file.type";
import { v4 as uuidv4 } from "uuid";
import { AdminFaceIdLoginDto } from "./dto/admin-face-id-login.dto";
import { AdminAuthService } from "../auth/admin/admin-auth.service";
import { UpdateFaceIdBrowserAccessDto } from "./dto/update-face-id-browser-access.dto";
import {
  hashBrowserFingerprint,
  normalizeBrowserFingerprint,
  normalizeBrowserLabel,
} from "./browser-fingerprint.util";

type FaceProfileRow = {
  id: string;
  admin_id: string;
  embedding: string;
  embedding_dimension: number;
  created_at: Date;
};

type FaceIdBrowserRow = {
  id: string;
  admin_id: string;
  fingerprint_hash: string;
  browser_label: string | null;
  user_agent: string | null;
  face_id_enabled: boolean;
  first_otp_verified_at: Date;
  last_otp_verified_at: Date;
  last_face_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

@Injectable()
export class FaceIdService {
  private readonly faceIdEnabled = process.env.FACE_ID_ENABLED !== "false";
  private readonly threshold = Number(process.env.FACE_ID_THRESHOLD ?? 0.75);
  private readonly maxUploadBytes =
    Number(process.env.FACE_ID_MAX_UPLOAD_SIZE_MB ?? 5) * 1024 * 1024;
  private readonly expectedEnrollImages = 5;
  private readonly allowedMimeTypes = new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
  ]);

  constructor(
    private readonly prisma: PrismaService,
    private readonly faceIdWorkerClient: FaceIdWorkerClient,
    private readonly adminAuthService: AdminAuthService,
  ) {}

  async getStatus(adminId: string, browserFingerprint?: string) {
    this.ensureFeatureEnabled();

    const profile = await this.findFaceProfileByAdminId(adminId);
    const currentBrowser = await this.buildBrowserStatus(
      adminId,
      browserFingerprint,
      Boolean(profile),
    );

    return {
      success: true,
      data: {
        hasFaceProfile: Boolean(profile),
        currentBrowser,
      },
    };
  }

  async enroll(adminId: string, files: UploadedImageFile[]) {
    this.ensureFeatureEnabled();

    if (!Array.isArray(files) || files.length !== this.expectedEnrollImages) {
      throw new BadRequestException({
        success: false,
        message: `Exactly ${this.expectedEnrollImages} images are required`,
      });
    }

    const embeddings: number[][] = [];

    for (const file of files) {
      this.validateImageFile(file);
      const result = await this.faceIdWorkerClient.extractEmbedding(file);
      embeddings.push(result.embedding);
    }

    const averagedEmbedding = this.normalizeVector(
      this.averageEmbeddings(embeddings),
    );

    await this.upsertFaceProfile(adminId, averagedEmbedding);

    return {
      success: true,
      message: "Face ID enrolled successfully",
    };
  }

  async login(
    payload: AdminFaceIdLoginDto,
    file: UploadedImageFile,
    userAgent?: string | string[],
  ) {
    this.ensureFeatureEnabled();
    this.validateImageFile(file);

    const email = payload.email.trim().toLowerCase();
    const browserFingerprint = this.requireBrowserFingerprint(
      payload.browserFingerprint,
    );
    const browserLabel = normalizeBrowserLabel(payload.browserLabel);
    const admin = await this.prisma.admin.findUnique({
      where: { email },
      select: { id: true, email: true },
    });

    if (!admin) {
      throw new NotFoundException({
        success: false,
        message: "Admin email not found",
        errorCode: "ADMIN_NOT_FOUND",
      });
    }

    const faceProfile = await this.findFaceProfileByAdminId(admin.id);

    if (!faceProfile) {
      throw new NotFoundException({
        success: false,
        message: "Admin has not enrolled Face ID",
        errorCode: "FACE_PROFILE_NOT_FOUND",
      });
    }

    const browser = await this.requireOtpVerifiedBrowser(
      admin.id,
      browserFingerprint,
    );

    if (!browser.face_id_enabled) {
      throw new ForbiddenException({
        success: false,
        message: "Face ID login is not enabled for this browser",
        errorCode: "FACE_ID_NOT_ENABLED_FOR_BROWSER",
      });
    }

    await this.touchBrowserMetadata(
      browser.id,
      browserLabel,
      this.normalizeUserAgent(userAgent),
    );

    const storedEmbedding = this.parseVectorLiteral(faceProfile.embedding);
    const { embedding: currentEmbedding } =
      await this.faceIdWorkerClient.extractEmbedding(file);

    if (storedEmbedding.length !== currentEmbedding.length) {
      throw new UnauthorizedException({
        success: false,
        message: "Face verification failed",
        errorCode: "FACE_NOT_MATCHED",
      });
    }

    const score = this.cosineSimilarity(
      this.normalizeVector(storedEmbedding),
      this.normalizeVector(currentEmbedding),
    );

    if (score < this.threshold) {
      throw new UnauthorizedException({
        success: false,
        message: "Face verification failed",
        errorCode: "FACE_NOT_MATCHED",
        score,
      });
    }

    await this.markFaceIdLoginUsed(browser.id);

    return this.adminAuthService.issueLoginSession(admin, false);
  }

  async updateBrowserAccess(
    adminId: string,
    payload: UpdateFaceIdBrowserAccessDto,
    userAgent?: string | string[],
  ) {
    this.ensureFeatureEnabled();

    const browserFingerprint = this.requireBrowserFingerprint(
      payload.browserFingerprint,
    );
    const browser = await this.requireOtpVerifiedBrowser(
      adminId,
      browserFingerprint,
    );

    await this.prisma.$executeRawUnsafe(
      `
        UPDATE "admin_face_id_browsers"
        SET
          "face_id_enabled" = $2,
          "browser_label" = COALESCE($3, "browser_label"),
          "user_agent" = COALESCE($4, "user_agent"),
          "updated_at" = NOW()
        WHERE "id" = $1
      `,
      browser.id,
      payload.enabled,
      normalizeBrowserLabel(payload.browserLabel),
      this.normalizeUserAgent(userAgent),
    );

    return {
      success: true,
      message: "Face ID browser access updated",
      data: {
        faceIdEnabled: payload.enabled,
      },
    };
  }

  async deleteProfile(adminId: string) {
    this.ensureFeatureEnabled();

    await this.prisma.$executeRawUnsafe(
      `DELETE FROM "admin_face_profiles" WHERE "admin_id" = $1`,
      adminId,
    );

    return {
      success: true,
      message: "Face ID profile deleted",
    };
  }

  private ensureFeatureEnabled() {
    if (!this.faceIdEnabled) {
      throw new ForbiddenException({
        success: false,
        message: "Face ID is disabled",
      });
    }
  }

  private requireBrowserFingerprint(
    browserFingerprint: string | null | undefined,
  ): string {
    const normalizedFingerprint =
      normalizeBrowserFingerprint(browserFingerprint);

    if (!normalizedFingerprint) {
      throw new BadRequestException({
        success: false,
        message: "Browser fingerprint is required",
        errorCode: "BROWSER_FINGERPRINT_REQUIRED",
      });
    }

    return normalizedFingerprint;
  }

  private validateImageFile(file: UploadedImageFile | undefined) {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException({
        success: false,
        message: "Image file is required",
        errorCode: "INVALID_IMAGE",
      });
    }

    if (!this.allowedMimeTypes.has(file.mimetype)) {
      throw new BadRequestException({
        success: false,
        message: "Invalid image",
        errorCode: "INVALID_IMAGE",
      });
    }

    if (file.size > this.maxUploadBytes) {
      throw new BadRequestException({
        success: false,
        message: "Image size exceeds limit",
        errorCode: "INVALID_IMAGE",
      });
    }
  }

  private averageEmbeddings(embeddings: number[][]): number[] {
    if (!embeddings.length) {
      throw new BadRequestException({
        success: false,
        message: "No valid face embeddings found",
      });
    }

    const dimension = embeddings[0].length;
    const sum = new Array<number>(dimension).fill(0);

    for (const embedding of embeddings) {
      if (embedding.length !== dimension) {
        throw new BadRequestException({
          success: false,
          message: "Embedding dimensions do not match",
        });
      }

      for (let index = 0; index < dimension; index += 1) {
        sum[index] += embedding[index];
      }
    }

    return sum.map((value) => value / embeddings.length);
  }

  private normalizeVector(vector: number[]): number[] {
    const magnitude = Math.sqrt(
      vector.reduce((acc, value) => acc + value * value, 0),
    );

    if (!Number.isFinite(magnitude) || magnitude === 0) {
      throw new BadRequestException({
        success: false,
        message: "Invalid face embedding",
        errorCode: "INVALID_IMAGE",
      });
    }

    return vector.map((value) => value / magnitude);
  }

  private cosineSimilarity(left: number[], right: number[]): number {
    let dotProduct = 0;

    for (let index = 0; index < left.length; index += 1) {
      dotProduct += left[index] * right[index];
    }

    return dotProduct;
  }

  private async upsertFaceProfile(adminId: string, embedding: number[]) {
    const embeddingLiteral = this.toVectorLiteral(embedding);

    await this.prisma.$executeRawUnsafe(
      `
        INSERT INTO "admin_face_profiles" (
          "id",
          "admin_id",
          "embedding",
          "embedding_dimension",
          "created_at"
        )
        VALUES ($1, $2, $3::vector, $4, NOW())
        ON CONFLICT ("admin_id")
        DO UPDATE SET
          "embedding" = EXCLUDED."embedding",
          "embedding_dimension" = EXCLUDED."embedding_dimension"
      `,
      uuidv4(),
      adminId,
      embeddingLiteral,
      embedding.length,
    );
  }

  private async buildBrowserStatus(
    adminId: string,
    browserFingerprint: string | undefined,
    hasFaceProfile: boolean,
  ) {
    const normalizedFingerprint =
      normalizeBrowserFingerprint(browserFingerprint);

    if (!normalizedFingerprint) {
      return {
        fingerprintProvided: false,
        hasOtpVerifiedBrowser: false,
        faceIdEnabled: false,
        canUseFaceIdLogin: false,
        browserLabel: null,
        lastOtpVerifiedAt: null,
      };
    }

    const browser = await this.findBrowserAccess(adminId, normalizedFingerprint);

    return {
      fingerprintProvided: true,
      hasOtpVerifiedBrowser: Boolean(browser),
      faceIdEnabled: Boolean(browser?.face_id_enabled),
      canUseFaceIdLogin:
        hasFaceProfile && Boolean(browser?.face_id_enabled && browser),
      browserLabel: browser?.browser_label ?? null,
      lastOtpVerifiedAt: browser?.last_otp_verified_at.toISOString() ?? null,
    };
  }

  private async findBrowserAccess(
    adminId: string,
    browserFingerprint: string,
  ): Promise<FaceIdBrowserRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<FaceIdBrowserRow[]>(
      `
        SELECT
          "id",
          "admin_id",
          "fingerprint_hash",
          "browser_label",
          "user_agent",
          "face_id_enabled",
          "first_otp_verified_at",
          "last_otp_verified_at",
          "last_face_login_at",
          "created_at",
          "updated_at"
        FROM "admin_face_id_browsers"
        WHERE "admin_id" = $1
          AND "fingerprint_hash" = $2
        LIMIT 1
      `,
      adminId,
      hashBrowserFingerprint(browserFingerprint),
    );

    return rows[0] ?? null;
  }

  private async requireOtpVerifiedBrowser(
    adminId: string,
    browserFingerprint: string,
  ): Promise<FaceIdBrowserRow> {
    const browser = await this.findBrowserAccess(adminId, browserFingerprint);

    if (!browser) {
      throw new ForbiddenException({
        success: false,
        message: "This browser has not logged in with OTP before",
        errorCode: "BROWSER_NOT_OTP_VERIFIED",
      });
    }

    return browser;
  }

  private async touchBrowserMetadata(
    browserId: string,
    browserLabel: string | null,
    userAgent: string | null,
  ) {
    await this.prisma.$executeRawUnsafe(
      `
        UPDATE "admin_face_id_browsers"
        SET
          "browser_label" = COALESCE($2, "browser_label"),
          "user_agent" = COALESCE($3, "user_agent"),
          "updated_at" = NOW()
        WHERE "id" = $1
      `,
      browserId,
      browserLabel,
      userAgent,
    );
  }

  private async markFaceIdLoginUsed(browserId: string) {
    await this.prisma.$executeRawUnsafe(
      `
        UPDATE "admin_face_id_browsers"
        SET
          "last_face_login_at" = NOW(),
          "updated_at" = NOW()
        WHERE "id" = $1
      `,
      browserId,
    );
  }

  private normalizeUserAgent(userAgent?: string | string[]) {
    if (Array.isArray(userAgent)) {
      return userAgent[0]?.trim() || null;
    }

    if (typeof userAgent === "string" && userAgent.trim()) {
      return userAgent.trim();
    }

    return null;
  }

  private async findFaceProfileByAdminId(adminId: string) {
    const rows = await this.prisma.$queryRawUnsafe<FaceProfileRow[]>(
      `
        SELECT
          "id",
          "admin_id",
          "embedding"::text AS "embedding",
          "embedding_dimension",
          "created_at"
        FROM "admin_face_profiles"
        WHERE "admin_id" = $1
        LIMIT 1
      `,
      adminId,
    );

    return rows[0] ?? null;
  }

  private toVectorLiteral(embedding: number[]): string {
    if (!embedding.length) {
      throw new BadRequestException({
        success: false,
        message: "Invalid face embedding",
      });
    }

    const values = embedding.map((value) => {
      if (!Number.isFinite(value)) {
        throw new BadRequestException({
          success: false,
          message: "Invalid face embedding",
        });
      }

      return Number(value.toFixed(12));
    });

    return `[${values.join(",")}]`;
  }

  private parseVectorLiteral(literal: string): number[] {
    const trimmed = literal.trim();

    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
      throw new BadRequestException({
        success: false,
        message: "Stored face profile is invalid",
      });
    }

    const rawValues = trimmed.slice(1, -1).split(",");
    const values = rawValues
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value));

    if (!values.length) {
      throw new BadRequestException({
        success: false,
        message: "Stored face profile is invalid",
      });
    }

    return values;
  }
}
