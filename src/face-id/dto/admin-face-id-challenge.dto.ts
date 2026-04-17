import { IsEmail, IsOptional, IsString, MaxLength } from "class-validator";

export class AdminFaceIdChallengeDto {
  @IsString()
  challengeNonce!: string;

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
