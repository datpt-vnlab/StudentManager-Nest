import {
  IsDateString,
  IsEmail,
  IsNotEmpty,
  IsString,
  IsUUID,
} from "class-validator";

export class CreateStudentDto {
  @IsString()
  @IsNotEmpty()
  first_name!: string;

  @IsString()
  @IsNotEmpty()
  last_name!: string;

  @IsEmail()
  email!: string;

  @IsUUID()
  major_id!: string;

  @IsString()
  @IsNotEmpty()
  address!: string;

  @IsString()
  @IsNotEmpty()
  gender!: string;

  @IsDateString()
  birthday!: string;

  @IsString()
  @IsNotEmpty()
  status!: string;
}
