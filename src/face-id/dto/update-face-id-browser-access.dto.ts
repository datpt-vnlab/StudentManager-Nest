import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateFaceIdBrowserAccessDto {
  @IsString()
  @MaxLength(255)
  browserFingerprint!: string;

  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  browserLabel?: string;
}
