import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { Roles } from "../auth/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { JwtUserPayload } from "../auth/types/jwt-user.type";
import { StudentAuthService } from "../auth/student/student-auth.service";
import { UpdateStudentPortalMeDto } from "./dto/update-student-portal-me.dto";

type RequestWithUser = Request & { user?: JwtUserPayload };

@Controller("student-portal")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("student")
export class StudentPortalController {
  constructor(private readonly studentAuthService: StudentAuthService) {}

  @Get("me")
  @HttpCode(HttpStatus.OK)
  async getMe(@Req() req: RequestWithUser) {
    if (!req.user?.sub) {
      throw new UnauthorizedException("Unauthorized");
    }

    return this.studentAuthService.getStudentPortalProfile(req.user.sub);
  }

  @Patch("me")
  @HttpCode(HttpStatus.OK)
  async updateMe(
    @Req() req: RequestWithUser,
    @Body() body: UpdateStudentPortalMeDto,
  ) {
    if (!req.user?.sub) {
      throw new UnauthorizedException("Unauthorized");
    }

    return this.studentAuthService.updateStudentPortalProfile(req.user.sub, body);
  }
}
