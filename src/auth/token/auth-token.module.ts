import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthTokenService } from "./auth-token.service";

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET ?? "dev_access_secret_change_me",
    }),
  ],
  providers: [AuthTokenService],
  exports: [AuthTokenService],
})
export class AuthTokenModule {}
