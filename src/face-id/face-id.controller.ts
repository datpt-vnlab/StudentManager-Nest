import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileFieldsInterceptor, FileInterceptor, FilesInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { JwtUserPayload } from "../auth/types/jwt-user.type";
import { FaceIdService } from "./face-id.service";
import { FaceIdWorkerClient } from "./face-id.worker-client";
import { UploadedImageFile } from "./types/uploaded-image-file.type";
import { AdminFaceIdLoginDto } from "./dto/admin-face-id-login.dto";
import { AdminFaceIdSilentDto } from "./dto/admin-face-id-silent.dto";
import { AdminFaceIdChallengeDto } from "./dto/admin-face-id-challenge.dto";
import { UpdateFaceIdBrowserAccessDto } from "./dto/update-face-id-browser-access.dto";

type RequestWithUser = Request & { user?: JwtUserPayload };

const maxUploadBytes =
  Number(process.env.FACE_ID_MAX_UPLOAD_SIZE_MB ?? 5) * 1024 * 1024;

@Controller("admin/faceid")
export class FaceIdController {
  constructor(
    private readonly faceIdService: FaceIdService,
    private readonly workerClient: FaceIdWorkerClient,
  ) {}

  private parseExpiresToMs(value: string, fallbackMs: number): number {
    const v = (value || "").trim();
    if (!v) return fallbackMs;

    if (/^\d+$/.test(v)) return Number(v) * 1000;

    const m = v.match(/^(\d+)([smhd])$/i);
    if (!m) return fallbackMs;

    const amount = Number(m[1]);
    const unit = m[2].toLowerCase();

    if (unit === "s") return amount * 1000;
    if (unit === "m") return amount * 60 * 1000;
    if (unit === "h") return amount * 60 * 60 * 1000;
    if (unit === "d") return amount * 24 * 60 * 60 * 1000;

    return fallbackMs;
  }

  private setAuthCookies(
    res: Response,
    accessToken: string,
    refreshToken: string,
    rememberMe: boolean,
  ) {
    const isSecure = process.env.COOKIE_SECURE === "true";
    const sameSite =
      (process.env.COOKIE_SAME_SITE as "lax" | "strict" | "none") || "lax";

    const accessMaxAge = this.parseExpiresToMs(
      process.env.JWT_ACCESS_EXPIRES_IN ?? "15m",
      15 * 60 * 1000,
    );

    const refreshExpiryByEnv = this.parseExpiresToMs(
      process.env.JWT_REFRESH_EXPIRES_IN ?? "30d",
      30 * 24 * 60 * 60 * 1000,
    );

    const refreshMaxAge = rememberMe ? refreshExpiryByEnv : 24 * 60 * 60 * 1000;

    res.cookie("access_token", accessToken, {
      httpOnly: true,
      secure: isSecure,
      sameSite,
      path: "/",
      maxAge: accessMaxAge,
    });

    res.cookie("refresh_token", refreshToken, {
      httpOnly: true,
      secure: isSecure,
      sameSite,
      path: "/",
      maxAge: refreshMaxAge,
    });
  }

  @Get("status")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("admin")
  @HttpCode(HttpStatus.OK)
  async getStatus(
    @Req() req: RequestWithUser,
    @Headers("x-browser-fingerprint") browserFingerprint?: string,
  ) {
    if (!req.user?.sub) {
      throw new UnauthorizedException("Unauthorized");
    }

    return this.faceIdService.getStatus(req.user.sub, browserFingerprint);
  }

  @Post("enroll")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("admin")
  @UseInterceptors(
    FilesInterceptor("images", 5, {
      limits: { files: 5, fileSize: maxUploadBytes },
    }),
  )
  @HttpCode(HttpStatus.OK)
  async enroll(
    @Req() req: RequestWithUser,
    @UploadedFiles() files: UploadedImageFile[],
  ) {
    if (!req.user?.sub) {
      throw new UnauthorizedException("Unauthorized");
    }

    return this.faceIdService.enroll(req.user.sub, files ?? []);
  }

  @Post("login")
  @UseInterceptors(
    FileInterceptor("image", {
      limits: { files: 1, fileSize: maxUploadBytes },
    }),
  )
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: AdminFaceIdLoginDto,
    @UploadedFile() file: UploadedImageFile,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.faceIdService.login(
      body,
      file,
      req.headers["user-agent"],
    );

    this.setAuthCookies(
      res,
      result.tokens.accessToken,
      result.tokens.refreshToken,
      false,
    );

    return {
      success: result.success,
      message: result.message,
      user: result.user,
      session: result.session,
      nextPage: result.nextPage,
    };
  }

  @Patch("browser-access")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("admin")
  @HttpCode(HttpStatus.OK)
  async updateBrowserAccess(
    @Req() req: RequestWithUser,
    @Body() body: UpdateFaceIdBrowserAccessDto,
  ) {
    if (!req.user?.sub) {
      throw new UnauthorizedException("Unauthorized");
    }

    return this.faceIdService.updateBrowserAccess(
      req.user.sub,
      body,
      req.headers["user-agent"],
    );
  }

  @Delete("profile")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("admin")
  @HttpCode(HttpStatus.OK)
  async deleteProfile(@Req() req: RequestWithUser) {
    if (!req.user?.sub) {
      throw new UnauthorizedException("Unauthorized");
    }

    return this.faceIdService.deleteProfile(req.user.sub);
  }

  // ---------------- Adaptive liveness (pre-auth, public) ----------------
  // All routes live under admin/faceid/* so the Next.js proxy paths
  // /api/auth/admin/faceid/{nonce,silent,challenge} map 1:1.

  @Post("nonce")
  @HttpCode(HttpStatus.OK)
  async issueNonce() {
    return this.workerClient.issueNonce();
  }

  @Post("silent")
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "frames", maxCount: 5 },
        { name: "full", maxCount: 1 },
      ],
      { limits: { fileSize: maxUploadBytes } },
    ),
  )
  @HttpCode(HttpStatus.OK)
  async silentAttempt(
    @Body() body: AdminFaceIdSilentDto,
    @UploadedFiles()
    files: { frames?: UploadedImageFile[]; full?: UploadedImageFile[] },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const frames = files?.frames ?? [];
    const full = files?.full?.[0];
    if (!body.nonce || frames.length !== 5 || !full) {
      throw new UnauthorizedException(
        "Expected nonce + 5 'frames' files + 1 'full' file",
      );
    }

    const workerResult = await this.workerClient.silentAttempt(
      body.nonce,
      frames,
      full,
    );

    // If liveness didn't fully pass, short-circuit — no session, no cookies.
    if (workerResult?.status !== "success") {
      return workerResult;
    }

    // Liveness passed. Finalize login: match face against enrolled admin and
    // issue the session cookies (same path as POST /admin/faceid/login).
    if (!body.email || !body.browserFingerprint) {
      throw new UnauthorizedException({
        success: false,
        message: "email and browserFingerprint are required to finalize login",
        errorCode: "FACE_LOGIN_CONTEXT_REQUIRED",
      });
    }

    const result = await this.faceIdService.login(
      {
        email: body.email,
        browserFingerprint: body.browserFingerprint,
        browserLabel: body.browserLabel,
      },
      full,
      req.headers["user-agent"],
    );

    this.setAuthCookies(
      res,
      result.tokens.accessToken,
      result.tokens.refreshToken,
      false,
    );

    return {
      status: "success",
      livenessScore: workerResult.livenessScore,
      antispoofScore: workerResult.antispoofScore,
      success: result.success,
      message: result.message,
      user: result.user,
      session: result.session,
      nextPage: result.nextPage,
    };
  }

  @Post("challenge")
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "frames", maxCount: 5 },
        { name: "full", maxCount: 1 },
      ],
      { limits: { fileSize: maxUploadBytes } },
    ),
  )
  @HttpCode(HttpStatus.OK)
  async challengeAttempt(
    @Body() body: AdminFaceIdChallengeDto,
    @UploadedFiles()
    files: { frames?: UploadedImageFile[]; full?: UploadedImageFile[] },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const frames = files?.frames ?? [];
    const full = files?.full?.[0];
    if (!body.challengeNonce || frames.length !== 5 || !full) {
      throw new UnauthorizedException(
        "Expected challengeNonce + 5 'frames' files + 1 'full' file",
      );
    }

    const workerResult = await this.workerClient.challengeAttempt(
      body.challengeNonce,
      frames,
      full,
    );

    if (workerResult?.status !== "success") {
      return workerResult;
    }

    if (!body.email || !body.browserFingerprint) {
      throw new UnauthorizedException({
        success: false,
        message: "email and browserFingerprint are required to finalize login",
        errorCode: "FACE_LOGIN_CONTEXT_REQUIRED",
      });
    }

    const result = await this.faceIdService.login(
      {
        email: body.email,
        browserFingerprint: body.browserFingerprint,
        browserLabel: body.browserLabel,
      },
      full,
      req.headers["user-agent"],
    );

    this.setAuthCookies(
      res,
      result.tokens.accessToken,
      result.tokens.refreshToken,
      false,
    );

    return {
      status: "success",
      livenessScore: workerResult.livenessScore,
      antispoofScore: workerResult.antispoofScore,
      prompt: workerResult.prompt,
      success: result.success,
      message: result.message,
      user: result.user,
      session: result.session,
      nextPage: result.nextPage,
    };
  }
}
