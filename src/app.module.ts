import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./health/health.module";
import { StudentAuthModule } from "./auth/student/student-auth.module";
import { AdminAuthModule } from "./auth/admin/admin-auth.module";
import { MailModule } from "./shared/mail/mail.module";
import { StudentPortalModule } from "./student-portal/student-portal.module";
import { StudentsModule } from "./students/students.module";

@Module({
  imports: [
    PrismaModule,
    HealthModule,
    MailModule,
    StudentAuthModule,
    AdminAuthModule,
    StudentPortalModule,
    StudentsModule,
  ],
})
export class AppModule {}
