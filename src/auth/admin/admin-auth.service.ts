import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../../shared/mail/mail.service";
import { AuthTokenService } from "../token/auth-token.service";
import { JwtUserPayload } from "../types/jwt-user.type";
import { SendOtpDto } from "./dto/send-otp.dto";
import { VerifyOtpDto } from "./dto/verify-otp.dto";
import {
  hashBrowserFingerprint,
  normalizeBrowserFingerprint,
  normalizeBrowserLabel,
} from "../../face-id/browser-fingerprint.util";

type AdminLoginUser = {
  id: string;
  email: string;
};

type BrowserRegistrationResult = {
  fingerprintCaptured: boolean;
  faceIdEnabledForThisBrowser: boolean;
};

@Injectable()
export class AdminAuthService {
  private readonly otpTtlMinutes = Number(process.env.OTP_TTL_MINUTES ?? 5);
  private readonly otpSaltRounds = Number(process.env.BCRYPT_SALT_ROUNDS ?? 10);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly authTokenService: AuthTokenService,
  ) {}

  issueLoginSession(admin: AdminLoginUser, rememberMe: boolean) {
    const jwtPayload: JwtUserPayload = {
      sub: admin.id,
      role: "admin",
      email: admin.email,
      rememberMe,
    };

    const { accessToken, refreshToken } =
      this.authTokenService.generateTokenPair(jwtPayload);

    return {
      success: true,
      message: "Login successful",
      user: {
        role: "admin" as const,
        adminId: admin.id,
        email: admin.email,
      },
      session: {
        type: "token_or_session" as const,
        rememberMeApplied: rememberMe,
      },
      tokens: {
        accessToken,
        refreshToken,
      },
      nextPage: "/admin/dashboard",
    };
  }

  private generateOtpCode(length = 6): string {
    const min = 10 ** (length - 1);
    const max = 10 ** length - 1;
    return String(Math.floor(Math.random() * (max - min + 1)) + min);
  }

  async sendOtp(payload: SendOtpDto) {
    const email = payload.email.trim().toLowerCase();

    const admin = await this.prisma.admin.findUnique({
      where: { email },
    });

    if (!admin) {
      throw new NotFoundException({
        success: false,
        message: "Admin email not found",
      });
    }

    const plainOtp = this.generateOtpCode(6);
    const hashedOtp = await bcrypt.hash(plainOtp, this.otpSaltRounds);
    const expiresAt = new Date(Date.now() + this.otpTtlMinutes * 60 * 1000);

    await this.prisma.admin.update({
      where: { id: admin.id },
      data: {
        otp_code: hashedOtp,
        otp_expires_at: expiresAt,
      },
    });

    await this.mailService.sendOtpEmail(email, plainOtp, this.otpTtlMinutes);

    return {
      success: true,
      message: "OTP sent to email",
    };
  }

  async verifyOtp(payload: VerifyOtpDto, userAgent?: string | string[]) {
    const email = payload.email.trim().toLowerCase();
    const rememberMe = Boolean(payload.rememberMe);

    const admin = await this.prisma.admin.findUnique({
      where: { email },
    });

    if (!admin || !admin.otp_code || !admin.otp_expires_at) {
      throw new UnauthorizedException({
        success: false,
        message: "Invalid or expired OTP",
        frontendAction: {
          resetFields: ["otp"],
          allowRetry: true,
        },
      });
    }

    const isExpired = admin.otp_expires_at.getTime() < Date.now();
    if (isExpired) {
      await this.prisma.admin.update({
        where: { id: admin.id },
        data: {
          otp_code: null,
          otp_expires_at: null,
        },
      });

      throw new UnauthorizedException({
        success: false,
        message: "Invalid or expired OTP",
        frontendAction: {
          resetFields: ["otp"],
          allowRetry: true,
        },
      });
    }

    const isOtpValid = await bcrypt.compare(payload.otp, admin.otp_code);

    if (!isOtpValid) {
      throw new UnauthorizedException({
        success: false,
        message: "Invalid or expired OTP",
        frontendAction: {
          resetFields: ["otp"],
          allowRetry: true,
        },
      });
    }

    // Invalidate OTP after successful verification (one-time use).
    await this.prisma.admin.update({
      where: { id: admin.id },
      data: {
        otp_code: null,
        otp_expires_at: null,
      },
    });

    const browserRegistration = await this.registerOtpVerifiedBrowser(
      admin.id,
      payload.browserFingerprint,
      payload.browserLabel,
      userAgent,
    );

    return {
      ...(this.issueLoginSession(admin, rememberMe)),
      message: "OTP verified",
      ...(browserRegistration ? { browserRegistration } : {}),
    };
  }

  private async registerOtpVerifiedBrowser(
    adminId: string,
    browserFingerprint?: string,
    browserLabel?: string,
    userAgent?: string | string[],
  ): Promise<BrowserRegistrationResult | undefined> {
    const normalizedFingerprint = normalizeBrowserFingerprint(browserFingerprint);
    if (!normalizedFingerprint) {
      return undefined;
    }

    const fingerprintHash = hashBrowserFingerprint(normalizedFingerprint);
    const normalizedBrowserLabel = normalizeBrowserLabel(browserLabel);
    const normalizedUserAgent = this.normalizeUserAgent(userAgent);

    const rows = await this.prisma.$queryRawUnsafe<
      { face_id_enabled: boolean }[]
    >(
      `
        INSERT INTO "admin_face_id_browsers" (
          "id",
          "admin_id",
          "fingerprint_hash",
          "browser_label",
          "user_agent",
          "face_id_enabled",
          "first_otp_verified_at",
          "last_otp_verified_at",
          "created_at",
          "updated_at"
        )
        VALUES ($1, $2, $3, $4, $5, FALSE, NOW(), NOW(), NOW(), NOW())
        ON CONFLICT ("admin_id", "fingerprint_hash")
        DO UPDATE SET
          "browser_label" = COALESCE(
            EXCLUDED."browser_label",
            "admin_face_id_browsers"."browser_label"
          ),
          "user_agent" = COALESCE(
            EXCLUDED."user_agent",
            "admin_face_id_browsers"."user_agent"
          ),
          "last_otp_verified_at" = NOW(),
          "updated_at" = NOW()
        RETURNING "face_id_enabled"
      `,
      uuidv4(),
      adminId,
      fingerprintHash,
      normalizedBrowserLabel,
      normalizedUserAgent,
    );

    return {
      fingerprintCaptured: true,
      faceIdEnabledForThisBrowser: rows[0]?.face_id_enabled ?? false,
    };
  }

  private normalizeUserAgent(userAgent?: string | string[]) {
    if (Array.isArray(userAgent)) {
      return userAgent[0] ?? null;
    }

    if (typeof userAgent === "string" && userAgent.trim()) {
      return userAgent.trim();
    }

    return null;
  }
}
