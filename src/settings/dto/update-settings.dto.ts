import { IsBoolean, IsInt, IsOptional, Min } from "class-validator";

export class UpdateSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  session_timeout?: number;

  @IsOptional()
  @IsBoolean()
  face_id_enabled?: boolean;
}
