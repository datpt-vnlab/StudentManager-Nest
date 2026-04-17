import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from "@nestjs/common";
import { Response } from "express";
import { StudentAuthService } from "./student-auth.service";
import { StudentLoginDto } from "./dto/student-login.dto";

@Controller("auth/student")
export class StudentAuthController {
  constructor(private readonly studentAuthService: StudentAuthService) {}

  private parseExpiresToMs(value: string, fallbackMs: number): number {
    const v = (value || "").trim();
    if (!v) return fallbackMs;

    if (/^\d+$/.test(v)) return Number(v) * 1000; // seconds

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

    const refreshMaxAge = rememberMe ? refreshExpiryByEnv : 24 * 60 * 60 * 1000; // 1 day if not rememberMe

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

  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: StudentLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.studentAuthService.login(body);

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
