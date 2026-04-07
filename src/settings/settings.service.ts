import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { v4 as uuidv4 } from "uuid";
import { UpdateSettingsDto } from "./dto/update-settings.dto";

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrentSettings(adminId: string) {
    const settings = await this.ensureSettings(adminId);

    return {
      success: true,
      settings,
    };
  }

  async updateCurrentSettings(adminId: string, payload: UpdateSettingsDto) {
    await this.ensureSettings(adminId);

    const settings = await this.prisma.adminSetting.update({
      where: { admin_id: adminId },
      data: {
        ...(payload.session_timeout !== undefined
          ? { session_timeout: payload.session_timeout }
          : {}),
        ...(payload.face_id_enabled !== undefined
          ? { face_id_enabled: payload.face_id_enabled }
          : {}),
        updated_at: new Date(),
      },
      select: {
        id: true,
        admin_id: true,
        session_timeout: true,
        face_id_enabled: true,
        updated_at: true,
      },
    });

    return {
      success: true,
      message: "Settings updated successfully",
      settings,
    };
  }

  private async ensureSettings(adminId: string) {
    const existing = await this.prisma.adminSetting.findUnique({
      where: { admin_id: adminId },
      select: {
        id: true,
        admin_id: true,
        session_timeout: true,
        face_id_enabled: true,
        updated_at: true,
      },
    });

    if (existing) {
      return existing;
    }

    return this.prisma.adminSetting.create({
      data: {
        id: uuidv4(),
        admin_id: adminId,
        session_timeout: 30,
        face_id_enabled: false,
        updated_at: new Date(),
      },
      select: {
        id: true,
        admin_id: true,
        session_timeout: true,
        face_id_enabled: true,
        updated_at: true,
      },
    });
  }
}
