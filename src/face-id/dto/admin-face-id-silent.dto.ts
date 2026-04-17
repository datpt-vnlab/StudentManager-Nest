import { IsEmail, IsOptional, IsString, MaxLength } from "class-validator";

export class AdminFaceIdSilentDto {
  @IsString()
  nonce!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  browserFingerprint?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  browserLabel?: string;
}
