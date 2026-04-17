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
import { AdminsService } from "./admins.service";
import { CreateAdminDto } from "./dto/create-admin.dto";
import { UpdateAdminDto } from "./dto/update-admin.dto";

@Controller("admins")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin")
export class AdminsController {
  constructor(private readonly adminsService: AdminsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async findAll() {
    return this.adminsService.findAll();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: CreateAdminDto) {
    return this.adminsService.create(body);
  }

  @Patch(":id")
  @HttpCode(HttpStatus.OK)
  async update(@Param("id") id: string, @Body() body: UpdateAdminDto) {
    return this.adminsService.update(id, body);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  async remove(@Param("id") id: string) {
    return this.adminsService.remove(id);
  }
}
