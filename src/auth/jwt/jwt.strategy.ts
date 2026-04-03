import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { Request } from "express";
import { JwtUserPayload, UserRole } from "../types/jwt-user.type";

type JwtRawPayload = {
  sub: string;
  role: UserRole;
  email?: string;
  displayName?: string;
  rememberMe?: boolean;
  tokenType?: "access" | "refresh";
  iat?: number;
  exp?: number;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request): string | null => {
          if (!req || !req.cookies) return null;
          return req.cookies.access_token ?? null;
        },
      ]),
      secretOrKey: process.env.JWT_ACCESS_SECRET ?? "dev_access_secret_change_me",
      ignoreExpiration: false,
    });
  }

  validate(payload: JwtRawPayload): JwtUserPayload {
    if (!payload?.sub || !payload?.role) {
      throw new UnauthorizedException("Invalid token payload");
    }

    if (payload.tokenType && payload.tokenType !== "access") {
      throw new UnauthorizedException("Invalid token type");
    }

    return {
      sub: payload.sub,
      role: payload.role,
      email: payload.email,
      displayName: payload.displayName,
      rememberMe: payload.rememberMe,
      iat: payload.iat,
      exp: payload.exp,
    };
  }
}
