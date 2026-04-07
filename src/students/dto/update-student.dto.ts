import {
  IsDateString,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from "class-validator";

export class UpdateStudentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  first_name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  last_name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsUUID()
  major_id?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  address?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  gender?: string;

  @IsOptional()
  @IsDateString()
  birthday?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  status?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  password_hash?: string;
}
