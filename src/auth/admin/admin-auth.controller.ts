import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from "@nestjs/common";
import { Response } from "express";
import { AdminAuthService } from "./admin-auth.service";
import { SendOtpDto } from "./dto/send-otp.dto";
import { VerifyOtpDto } from "./dto/verify-otp.dto";

@Controller("auth/admin/otp")
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

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

  @Post("send")
  @HttpCode(HttpStatus.OK)
  async sendOtp(@Body() body: SendOtpDto) {
    return this.adminAuthService.sendOtp(body);
  }

  @Post("verify")
  @HttpCode(HttpStatus.OK)
  async verifyOtp(
    @Body() body: VerifyOtpDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.adminAuthService.verifyOtp(body);

    this.setAuthCookies(
      res,
      result.tokens.accessToken,
      result.tokens.refreshToken,
      Boolean(body.rememberMe),
    );

    return {
      success: result.success,
      message: result.message,
      user: result.user,
      session: result.session,
      nextPage: result.nextPage,
    };
  }
}
