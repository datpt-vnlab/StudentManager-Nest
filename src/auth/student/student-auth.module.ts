import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { StudentAuthController } from "./student-auth.controller";
import { StudentAuthService } from "./student-auth.service";
import { AuthTokenModule } from "../token/auth-token.module";
import { JwtStrategy } from "../jwt/jwt.strategy";
import { JwtAuthGuard } from "../guards/jwt-auth.guard";
import { RolesGuard } from "../guards/roles.guard";

@Module({
  imports: [
    AuthTokenModule,
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET ?? "dev_access_secret_change_me",
    }),
  ],
  controllers: [StudentAuthController],
  providers: [StudentAuthService, JwtStrategy, JwtAuthGuard, RolesGuard],
  exports: [StudentAuthService, JwtAuthGuard, RolesGuard],
})
export class StudentAuthModule {}
