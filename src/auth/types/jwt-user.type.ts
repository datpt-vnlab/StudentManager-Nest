export type UserRole = "student" | "admin";

export type JwtUserPayload = {
  sub: string;
  role: UserRole;
  email?: string;
  displayName?: string;
  rememberMe?: boolean;
  iat?: number;
  exp?: number;
};
