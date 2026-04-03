import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { JwtUserPayload, UserRole } from "../types/jwt-user.type";

type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

type AccessTokenPayload = {
  sub: string;
  role: UserRole;
  email?: string;
  displayName?: string;
  tokenType: "access";
};

type RefreshTokenPayload = {
  sub: string;
  role: UserRole;
  tokenType: "refresh";
};

type JwtSignOptions = NonNullable<Parameters<JwtService["sign"]>[1]>;
type JwtExpiresIn = JwtSignOptions["expiresIn"];

@Injectable()
export class AuthTokenService {
  private readonly defaultAccessExpiresIn: JwtExpiresIn = "15m" as JwtExpiresIn;
  private readonly defaultRefreshExpiresIn: JwtExpiresIn =
    "30d" as JwtExpiresIn;
  private readonly accessSecret =
    process.env.JWT_ACCESS_SECRET ?? "dev_access_secret_change_me";
  private readonly refreshSecret =
    process.env.JWT_REFRESH_SECRET ?? "dev_refresh_secret_change_me";
  private readonly accessExpiresIn = this.getExpiresIn(
    process.env.JWT_ACCESS_EXPIRES_IN,
    this.defaultAccessExpiresIn,
  );
  private readonly refreshExpiresIn = this.getExpiresIn(
    process.env.JWT_REFRESH_EXPIRES_IN,
    this.defaultRefreshExpiresIn,
  );

  constructor(private readonly jwtService: JwtService) {}

  private getExpiresIn(
    value: string | undefined,
    fallback: JwtExpiresIn,
  ): JwtExpiresIn {
    if (!value) {
      return fallback;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? (trimmed as JwtExpiresIn) : fallback;
  }

  generateAccessToken(user: JwtUserPayload): string {
    const payload: AccessTokenPayload = {
      sub: user.sub,
      role: user.role,
      email: user.email,
      displayName: user.displayName,
      tokenType: "access",
    };

    return this.jwtService.sign(payload, {
      secret: this.accessSecret,
      expiresIn: this.accessExpiresIn,
    });
  }

  generateRefreshToken(user: JwtUserPayload): string {
    const payload: RefreshTokenPayload = {
      sub: user.sub,
      role: user.role,
      tokenType: "refresh",
    };

    return this.jwtService.sign(payload, {
      secret: this.refreshSecret,
      expiresIn: this.refreshExpiresIn,
    });
  }

  generateTokenPair(user: JwtUserPayload): TokenPair {
    return {
      accessToken: this.generateAccessToken(user),
      refreshToken: this.generateRefreshToken(user),
    };
  }

  verifyAccessToken(token: string): JwtUserPayload {
    const payload = this.jwtService.verify<AccessTokenPayload>(token, {
      secret: this.accessSecret,
    });

    return {
      sub: payload.sub,
      role: payload.role,
      email: payload.email,
      displayName: payload.displayName,
    };
  }

  verifyRefreshToken(token: string): JwtUserPayload {
    const payload = this.jwtService.verify<RefreshTokenPayload>(token, {
      secret: this.refreshSecret,
    });

    return {
      sub: payload.sub,
      role: payload.role,
    };
  }
}
