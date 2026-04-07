import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { v4 as uuidv4 } from "uuid";
import { CreateAdminDto } from "./dto/create-admin.dto";
import { UpdateAdminDto } from "./dto/update-admin.dto";

@Injectable()
export class AdminsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const admins = await this.prisma.admin.findMany({
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        name: true,
        email: true,
        created_at: true,
      },
    });

    return {
      success: true,
      admins,
    };
  }

  async create(payload: CreateAdminDto) {
    try {
      const admin = await this.prisma.admin.create({
        data: {
          id: uuidv4(),
          name: payload.name.trim(),
          email: payload.email.trim().toLowerCase(),
          created_at: new Date(),
          settings: {
            create: {
              id: uuidv4(),
              face_id_enabled: false,
              session_timeout: 30,
              updated_at: new Date(),
            },
          },
        },
        select: {
          id: true,
          name: true,
          email: true,
          created_at: true,
        },
      });

      return {
        success: true,
        message: "Admin created successfully",
        admin,
      };
    } catch (error) {
      if (this.isUniqueConstraint(error, "email")) {
        throw new ConflictException({
          success: false,
          message: "Admin email already exists",
        });
      }

      throw error;
    }
  }

  async update(adminId: string, payload: UpdateAdminDto) {
    await this.ensureAdminExists(adminId);

    const data: Prisma.AdminUpdateInput = {};

    if (payload.name !== undefined) {
      data.name = payload.name.trim();
    }

    if (payload.email !== undefined) {
      data.email = payload.email.trim().toLowerCase();
    }

    try {
      const admin = await this.prisma.admin.update({
        where: { id: adminId },
        data,
        select: {
          id: true,
          name: true,
          email: true,
          created_at: true,
        },
      });

      return {
        success: true,
        message: "Admin updated successfully",
        admin,
      };
    } catch (error) {
      if (this.isUniqueConstraint(error, "email")) {
        throw new ConflictException({
          success: false,
          message: "Admin email already exists",
        });
      }

      throw error;
    }
  }

  async remove(adminId: string) {
    await this.ensureAdminExists(adminId);

    await this.prisma.admin.delete({
      where: { id: adminId },
    });

    return {
      success: true,
      message: "Admin deleted successfully",
    };
  }

  private async ensureAdminExists(adminId: string) {
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
      select: { id: true },
    });

    if (!admin) {
      throw new NotFoundException({
        success: false,
        message: "Admin not found",
      });
    }
  }

  private isUniqueConstraint(
    error: unknown,
    field: "email",
  ): error is Prisma.PrismaClientKnownRequestError {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      Array.isArray(error.meta?.target) &&
      error.meta.target.includes(field)
    );
  }
}
