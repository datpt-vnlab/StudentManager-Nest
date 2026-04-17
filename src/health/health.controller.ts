import { Controller, Get } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";

const testStudentIds = ["STU20260001", "STU20260002"];

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("db")
  async checkDb() {
    // lightweight DB check
    await this.prisma.$queryRaw`SELECT 1`;

    // optional: test Prisma model access
    const adminCount = await this.prisma.admin.count();

    return {
      ok: true,
      database: "connected",
      adminCount,
      timestamp: new Date().toISOString(),
    };
  }

  @Get("studenttestreset")
  async studentTestReset() {
    const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS ?? 10);
    const hashed = await bcrypt.hash("123456", saltRounds);

    const result = await this.prisma.student.updateMany({
      where: {
        id: {
          in: testStudentIds,
        },
      },
      data: {
        password_hash: hashed,
      },
    });

    return {
      ok: true,
      message: 'Reset password for test students to "123456".',
      updatedCount: result.count,
      studentIds: testStudentIds,
    };
  }
}
