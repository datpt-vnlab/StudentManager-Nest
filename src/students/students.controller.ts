import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Roles } from "../auth/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { CreateStudentDto } from "./dto/create-student.dto";
import { UpdateStudentDto } from "./dto/update-student.dto";
import { StudentsService } from "./students.service";

@Controller("students")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin")
export class StudentsController {
  constructor(private readonly studentsService: StudentsService) {}

  @Get("major")
  @HttpCode(HttpStatus.OK)
  async listMajors() {
    return this.studentsService.listMajors();
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async findAll() {
    return this.studentsService.findAll();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: CreateStudentDto) {
    return this.studentsService.create(body);
  }

  @Patch(":id")
  @HttpCode(HttpStatus.OK)
  async update(@Param("id") id: string, @Body() body: UpdateStudentDto) {
    return this.studentsService.update(id, body);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  async remove(@Param("id") id: string) {
    return this.studentsService.remove(id);
  }
}
