import { Module } from "@nestjs/common";
import { StudentAuthModule } from "../auth/student/student-auth.module";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";

@Module({
  imports: [StudentAuthModule],
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}
