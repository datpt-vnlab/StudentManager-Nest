import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { AdminAuthService } from "./admin-auth.service";
import { SendOtpDto } from "./dto/send-otp.dto";
import { VerifyOtpDto } from "./dto/verify-otp.dto";

@Controller("admin/auth/otp")
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Post("send")
  @HttpCode(HttpStatus.OK)
  async sendOtp(@Body() body: SendOtpDto) {
    return this.adminAuthService.sendOtp(body);
  }

  @Post("verify")
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() body: VerifyOtpDto) {
    return this.adminAuthService.verifyOtp(body);
  }
}
