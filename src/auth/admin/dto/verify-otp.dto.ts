import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  Length,
} from "class-validator";

export class VerifyOtpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(6, 6)
  otp!: string;

  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  browserFingerprint?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  browserLabel?: string;
}
