import { IsBoolean, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class StudentLoginDto {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;

  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
