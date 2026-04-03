import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from "class-validator";

export class UpdateStudentPortalMeDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  newPassword?: string;

  // Accepted and ignored to match the API design under whitelist validation.
  @IsOptional()
  @IsString()
  id?: string;

  // Accepted and ignored to match the API design under whitelist validation.
  @IsOptional()
  @IsString()
  status?: string;
}
