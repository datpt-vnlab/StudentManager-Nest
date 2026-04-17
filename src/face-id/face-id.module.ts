import { Module } from "@nestjs/common";
import { FaceIdController } from "./face-id.controller";
import { FaceIdService } from "./face-id.service";
import { FaceIdWorkerClient } from "./face-id.worker-client";
import { AdminAuthModule } from "../auth/admin/admin-auth.module";

@Module({
  imports: [AdminAuthModule],
  controllers: [FaceIdController],
  providers: [FaceIdService, FaceIdWorkerClient],
})
export class FaceIdModule {}
