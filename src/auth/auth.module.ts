import { Module } from "@nestjs/common";
import { StudentAuthModule } from "./student/student-auth.module";
import { AdminAuthModule } from "./admin/admin-auth.module";

@Module({
  imports: [StudentAuthModule, AdminAuthModule],
})
export class AuthModule {}
