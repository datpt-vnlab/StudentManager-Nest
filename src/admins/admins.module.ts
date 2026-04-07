import { Module } from "@nestjs/common";
import { StudentAuthModule } from "../auth/student/student-auth.module";
import { AdminsController } from "./admins.controller";
import { AdminsService } from "./admins.service";

@Module({
  imports: [StudentAuthModule],
  controllers: [AdminsController],
  providers: [AdminsService],
})
export class AdminsModule {}
