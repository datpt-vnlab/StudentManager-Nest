import { Module } from "@nestjs/common";
import { StudentAuthModule } from "../auth/student/student-auth.module";
import { StudentsController } from "./students.controller";
import { StudentsService } from "./students.service";

@Module({
  imports: [StudentAuthModule],
  controllers: [StudentsController],
  providers: [StudentsService],
})
export class StudentsModule {}
