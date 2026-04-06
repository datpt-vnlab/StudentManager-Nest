import { IsEmail, IsNotEmpty, IsString } from "class-validator";

export class CreateStudentDto {
  @IsString()
  @IsNotEmpty()
  first_name!: string;

  @IsString()
  @IsNotEmpty()
  last_name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  status!: string;
}
