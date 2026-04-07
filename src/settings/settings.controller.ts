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
import { UpdateSettingsDto } from "./dto/update-settings.dto";
import { SettingsService } from "./settings.service";

type RequestWithUser = Request & { user?: JwtUserPayload };

@Controller("settings")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin")
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async getCurrentSettings(@Req() req: RequestWithUser) {
    if (!req.user?.sub) {
      throw new UnauthorizedException("Unauthorized");
    }

    return this.settingsService.getCurrentSettings(req.user.sub);
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  async updateCurrentSettings(
    @Req() req: RequestWithUser,
    @Body() body: UpdateSettingsDto,
  ) {
    if (!req.user?.sub) {
      throw new UnauthorizedException("Unauthorized");
    }

    return this.settingsService.updateCurrentSettings(req.user.sub, body);
  }
}
