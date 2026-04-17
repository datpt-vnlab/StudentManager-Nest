import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateStudentDto } from "./dto/create-student.dto";
import { UpdateStudentDto } from "./dto/update-student.dto";

@Injectable()
export class StudentsService {
  private readonly bcryptSaltRounds = Number(
    process.env.BCRYPT_SALT_ROUNDS ?? 10,
  );

  constructor(private readonly prisma: PrismaService) {}

  async listMajors() {
    const majors = await this.prisma.$queryRaw<
      Array<{ id: string; major_name: string; created_at: Date }>
    >`
      SELECT id, major_name, created_at
      FROM "Major"
      ORDER BY major_name ASC
    `;

    return {
      success: true,
      majors: majors.map((major) => ({
        id: major.id,
        name: major.major_name,
      })),
    };
  }

  async findAll() {
    const students = await this.prisma.student.findMany({
      orderBy: { created_at: "desc" },
      include: {
        major: true,
      },
    });

    return {
      success: true,
      students,
    };
  }

  async create(payload: CreateStudentDto) {
    const data = this.normalizeCreatePayload(payload);
    await this.ensureMajorExists(data.major_id);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const studentId = await this.generateNextStudentId();
      const passwordHash = await bcrypt.hash(studentId, this.bcryptSaltRounds);

      try {
        const student = await this.prisma.student.create({
          data: {
            id: studentId,
            password_hash: passwordHash,
            first_name: data.first_name,
            last_name: data.last_name,
            email: data.email,
            address: data.address,
            gender: data.gender,
            birthday: data.birthday,
            status: data.status,
            created_at: new Date(),
            major: {
              connect: { id: data.major_id },
            },
          },
          include: {
            major: true,
          },
        });

        return {
          success: true,
          message: "Student created successfully",
          student,
          credentials: {
            initialPassword: studentId,
          },
        };
      } catch (error) {
        if (this.isUniqueConstraint(error, "email")) {
          throw new ConflictException({
            success: false,
            message: "Student email already exists",
          });
        }

        if (this.isUniqueConstraint(error, "id") && attempt < 2) {
          continue;
        }

        throw error;
      }
    }

    throw new ConflictException({
      success: false,
      message: "Failed to generate a unique student ID",
    });
  }

  async update(studentId: string, payload: UpdateStudentDto) {
    await this.ensureStudentExists(studentId);

    if (payload.major_id !== undefined) {
      await this.ensureMajorExists(payload.major_id);
    }

    const data = await this.buildUpdateData(payload);

    try {
      const student = await this.prisma.student.update({
        where: { id: studentId },
        data,
        include: {
          major: true,
        },
      });

      return {
        success: true,
        message: "Student updated successfully",
        student,
      };
    } catch (error) {
      if (this.isUniqueConstraint(error, "email")) {
        throw new ConflictException({
          success: false,
          message: "Student email already exists",
        });
      }

      throw error;
    }
  }

  async remove(studentId: string) {
    await this.ensureStudentExists(studentId);

    await this.prisma.student.delete({
      where: { id: studentId },
    });

    return {
      success: true,
      message: "Student deleted successfully",
    };
  }

  private normalizeCreatePayload(payload: CreateStudentDto) {
    return {
      first_name: payload.first_name.trim(),
      last_name: payload.last_name.trim(),
      email: payload.email.trim().toLowerCase(),
      major_id: payload.major_id,
      address: payload.address.trim(),
      gender: payload.gender.trim(),
      birthday: new Date(payload.birthday),
      status: payload.status.trim(),
    };
  }

  private async buildUpdateData(payload: UpdateStudentDto) {
    const data: Record<string, unknown> = {};

    if (payload.first_name !== undefined) {
      data.first_name = payload.first_name.trim();
    }

    if (payload.last_name !== undefined) {
      data.last_name = payload.last_name.trim();
    }

    if (payload.email !== undefined) {
      data.email = payload.email.trim().toLowerCase();
    }

    if (payload.major_id !== undefined) {
      data.major = {
        connect: { id: payload.major_id },
      };
    }

    if (payload.address !== undefined) {
      data.address = payload.address.trim();
    }

    if (payload.gender !== undefined) {
      data.gender = payload.gender.trim();
    }

    if (payload.birthday !== undefined) {
      data.birthday = new Date(payload.birthday);
    }

    if (payload.status !== undefined) {
      data.status = payload.status.trim();
    }

    if (payload.password_hash !== undefined) {
      data.password_hash = await bcrypt.hash(
        payload.password_hash,
        this.bcryptSaltRounds,
      );
    }

    return data as Prisma.StudentUpdateInput;
  }

  private async generateNextStudentId() {
    const year = new Date().getFullYear();
    const prefix = `STU${year}`;

    const latestStudent = await this.prisma.student.findFirst({
      where: {
        id: {
          startsWith: prefix,
        },
      },
      orderBy: {
        id: "desc",
      },
      select: {
        id: true,
      },
    });

    const lastSequence = latestStudent
      ? Number(latestStudent.id.slice(prefix.length))
      : 0;

    return `${prefix}${String(lastSequence + 1).padStart(4, "0")}`;
  }

  private async ensureStudentExists(studentId: string) {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true },
    });

    if (!student) {
      throw new NotFoundException({
        success: false,
        message: "Student not found",
      });
    }
  }

  private async ensureMajorExists(majorId: string) {
    const major = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "Major"
      WHERE id = ${majorId}
      LIMIT 1
    `;

    if (major.length === 0) {
      throw new NotFoundException({
        success: false,
        message: "Major not found",
      });
    }
  }

  private isUniqueConstraint(
    error: unknown,
    field: "id" | "email",
  ): error is Prisma.PrismaClientKnownRequestError {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      Array.isArray(error.meta?.target) &&
      error.meta.target.includes(field)
    );
  }
}
