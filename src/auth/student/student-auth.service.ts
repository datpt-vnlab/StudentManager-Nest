import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../../prisma/prisma.service";
import { AuthTokenService } from "../token/auth-token.service";
import { JwtUserPayload } from "../types/jwt-user.type";
import { Prisma } from "../../../generated/prisma/client";
import { StudentLoginDto } from "./dto/student-login.dto";
import { StudentChangePasswordDto } from "./dto/student-change-password.dto";
import { UpdateStudentPortalMeDto } from "../../student-portal/dto/update-student-portal-me.dto";

@Injectable()
export class StudentAuthService {
  private readonly bcryptSaltRounds = Number(
    process.env.BCRYPT_SALT_ROUNDS ?? 10,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly authTokenService: AuthTokenService,
  ) {}

  async login(payload: StudentLoginDto) {
    const username = payload.username?.trim();
    const password = payload.password ?? "";
    const rememberMe = Boolean(payload.rememberMe);

    const student = await this.prisma.student.findUnique({
      where: { id: username },
    });

    if (!student) {
      throw new UnauthorizedException({
        success: false,
        message: "Invalid username or password",
        frontendAction: {
          resetFields: ["password"],
          allowRetry: true,
        },
      });
    }

    const isPasswordValid = await bcrypt.compare(
      password,
      student.password_hash,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException({
        success: false,
        message: "Invalid username or password",
        frontendAction: {
          resetFields: ["password"],
          allowRetry: true,
        },
      });
    }

    const displayName = `${student.first_name} ${student.last_name}`.trim();

    const jwtPayload: JwtUserPayload = {
      sub: student.id,
      role: "student",
      email: student.email,
      displayName,
      rememberMe,
    };

    const { accessToken, refreshToken } =
      this.authTokenService.generateTokenPair(jwtPayload);

    return {
      success: true,
      message: "Login successful",
      user: {
        role: "student",
        studentId: student.id,
        displayName,
      },
      session: {
        type: "token_or_session",
        rememberMeApplied: rememberMe,
      },
      tokens: {
        accessToken,
        refreshToken,
      },
      nextPage: "/student/profile",
    };
  }

  async getStudentPortalProfile(studentId: string) {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      include: {
        major: true,
      },
    });

    if (!student) {
      throw new NotFoundException({
        success: false,
        message: "Student not found",
      });
    }

    return {
      success: true,
      student: {
        id: student.id,
        firstName: student.first_name,
        lastName: student.last_name,
        name: `${student.first_name} ${student.last_name}`.trim(),
        email: student.email,
        majorId: student.major_id,
        major: student.major
          ? {
              id: student.major.id,
              major_name: student.major.major_name,
            }
          : null,
        address: student.address,
        gender: student.gender,
        birthday: student.birthday,
        status: student.status,
      },
    };
  }

  async changePassword(studentId: string, payload: StudentChangePasswordDto) {
    const currentPassword = payload.currentPassword ?? "";
    const newPassword = payload.newPassword ?? "";

    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        password_hash: true,
      },
    });

    if (!student) {
      throw new NotFoundException({
        success: false,
        message: "Student not found",
      });
    }

    const isCurrentPasswordValid = await bcrypt.compare(
      currentPassword,
      student.password_hash,
    );

    if (!isCurrentPasswordValid) {
      throw new UnauthorizedException({
        success: false,
        message: "Current password is incorrect",
      });
    }

    const newPasswordHash = await bcrypt.hash(
      newPassword,
      this.bcryptSaltRounds,
    );

    await this.prisma.student.update({
      where: { id: student.id },
      data: {
        password_hash: newPasswordHash,
      },
    });

    return {
      success: true,
      message: "Password changed successfully",
    };
  }

  async updateStudentPortalProfile(
    studentId: string,
    payload: UpdateStudentPortalMeDto,
  ) {
    const email = payload.email?.trim();
    const address = payload.address?.trim();
    const shouldChangePassword =
      payload.currentPassword !== undefined ||
      payload.newPassword !== undefined;

    if (shouldChangePassword) {
      if (!payload.currentPassword || !payload.newPassword) {
        throw new UnauthorizedException({
          success: false,
          message:
            "Current password and new password are required to change password",
        });
      }

      await this.changePassword(studentId, {
        currentPassword: payload.currentPassword,
        newPassword: payload.newPassword,
      });
    }

    if (email || address !== undefined) {
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

      try {
        await this.prisma.student.update({
          where: { id: studentId },
          data: {
            ...(email ? { email: email.toLowerCase() } : {}),
            ...(address !== undefined ? { address } : {}),
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002" &&
          Array.isArray(error.meta?.target) &&
          error.meta.target.includes("email")
        ) {
          throw new ConflictException({
            success: false,
            message: "Student email already exists",
          });
        }

        throw error;
      }
    }

    return {
      success: true,
      message: "Profile updated successfully",
      student: (await this.getStudentPortalProfile(studentId)).student,
    };
  }
}
