import { Module } from "@nestjs/common";
import { StudentAuthModule } from "../auth/student/student-auth.module";
import { StudentPortalController } from "./student-portal.controller";

@Module({
  imports: [StudentAuthModule],
  controllers: [StudentPortalController],
})
export class StudentPortalModule {}
