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

  async findAll() {
    const students = await this.prisma.student.findMany({
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        status: true,
        created_at: true,
      },
    });

    return {
      success: true,
      students,
    };
  }

  async create(payload: CreateStudentDto) {
    const data = this.normalizeCreatePayload(payload);

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
            status: data.status,
            created_at: new Date(),
          },
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
            status: true,
            created_at: true,
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

    const data = await this.buildUpdateData(payload);

    try {
      const student = await this.prisma.student.update({
        where: { id: studentId },
        data,
        select: {
          id: true,
          first_name: true,
          last_name: true,
          email: true,
          status: true,
          created_at: true,
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
      status: payload.status.trim(),
    };
  }

  private async buildUpdateData(payload: UpdateStudentDto) {
    const data: Prisma.StudentUpdateInput = {};

    if (payload.first_name !== undefined) {
      data.first_name = payload.first_name.trim();
    }

    if (payload.last_name !== undefined) {
      data.last_name = payload.last_name.trim();
    }

    if (payload.email !== undefined) {
      data.email = payload.email.trim().toLowerCase();
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

    return data;
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
