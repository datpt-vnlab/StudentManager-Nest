import "dotenv/config";
import * as bcrypt from "bcrypt";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { v4 as uuidv4 } from "uuid";

const connectionString = `${process.env.DATABASE_URL}`;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const bcryptSaltRounds = Number(process.env.BCRYPT_SALT_ROUNDS ?? 10);
const seedYear = 2026;

const majors = [
  "Computer Science",
  "Information Technology",
  "Software Engineering",
  "Data Science",
  "Cybersecurity",
  "Business Administration",
  "Finance",
  "Marketing",
  "Mechanical Engineering",
  "Civil Engineering",
];

const studentSeeds = [
  {
    id: `STU${seedYear}0001`,
    first_name: "Nguyen",
    last_name: "An",
    email: "an.nguyen@uni.vn",
    major_name: "Computer Science",
    address: "12 Le Loi, District 1, Ho Chi Minh City",
    gender: "Male",
    birthday: new Date("2004-03-14"),
    status: "active",
  },
  {
    id: `STU${seedYear}0002`,
    first_name: "Tran",
    last_name: "Binh",
    email: "binh.tran@uni.vn",
    major_name: "Information Technology",
    address: "88 Nguyen Hue, District 1, Ho Chi Minh City",
    gender: "Male",
    birthday: new Date("2004-09-28"),
    status: "inactive",
  },
  {
    id: `STU${seedYear}0003`,
    first_name: "Le",
    last_name: "Chi",
    email: "chi.le@uni.vn",
    major_name: "Software Engineering",
    address: "45 Tran Hung Dao, Da Nang",
    gender: "Female",
    birthday: new Date("2005-01-09"),
    status: "active",
  },
  {
    id: `STU${seedYear}0004`,
    first_name: "Pham",
    last_name: "Dung",
    email: "dung.pham@uni.vn",
    major_name: "Data Science",
    address: "102 Vo Van Tan, District 3, Ho Chi Minh City",
    gender: "Female",
    birthday: new Date("2004-07-19"),
    status: "active",
  },
  {
    id: `STU${seedYear}0005`,
    first_name: "Hoang",
    last_name: "Gia",
    email: "gia.hoang@uni.vn",
    major_name: "Cybersecurity",
    address: "17 Phan Chau Trinh, Hoi An",
    gender: "Male",
    birthday: new Date("2003-12-02"),
    status: "inactive",
  },
  {
    id: `STU${seedYear}0006`,
    first_name: "Vo",
    last_name: "Ha",
    email: "ha.vo@uni.vn",
    major_name: "Business Administration",
    address: "63 Cach Mang Thang 8, Nha Trang",
    gender: "Female",
    birthday: new Date("2005-05-25"),
    status: "active",
  },
  {
    id: `STU${seedYear}0007`,
    first_name: "Bui",
    last_name: "Khanh",
    email: "khanh.bui@uni.vn",
    major_name: "Mechanical Engineering",
    address: "211 Dien Bien Phu, Binh Thanh, Ho Chi Minh City",
    gender: "Male",
    birthday: new Date("2004-11-11"),
    status: "active",
  },
];

async function main() {
  const adminId = uuidv4();

  await prisma.faceProfile.deleteMany();
  await prisma.adminSetting.deleteMany();
  await prisma.student.deleteMany();
  await prisma.admin.deleteMany();
  await prisma.major.deleteMany();

  const createdMajors = await Promise.all(
    majors.map((major_name) =>
      prisma.major.create({
        data: {
          id: uuidv4(),
          major_name,
          created_at: new Date(),
        },
      }),
    ),
  );

  const majorIdByName = new Map(
    createdMajors.map((major) => [major.major_name, major.id]),
  );

  await prisma.admin.create({
    data: {
      id: adminId,
      name: "Admin 1",
      email: "datphantuan2@gmail.com",
      created_at: new Date(),
    },
  });

  await prisma.adminSetting.create({
    data: {
      id: uuidv4(),
      admin_id: adminId,
      face_id_enabled: false,
      session_timeout: 30,
      updated_at: new Date(),
    },
  });

  await prisma.faceProfile.create({
    data: {
      id: uuidv4(),
      admin_id: adminId,
      descriptor: { vector: [0.1, 0.2, 0.3] },
      created_at: new Date(),
    },
  });

  for (const student of studentSeeds) {
    const majorId = majorIdByName.get(student.major_name);

    if (!majorId) {
      throw new Error(
        `Major not found for student seed: ${student.major_name}`,
      );
    }

    await prisma.student.create({
      data: {
        id: student.id,
        password_hash: await bcrypt.hash(student.id, bcryptSaltRounds),
        first_name: student.first_name,
        last_name: student.last_name,
        email: student.email,
        major_id: majorId,
        address: student.address,
        gender: student.gender,
        birthday: student.birthday,
        status: student.status,
        created_at: new Date(),
      },
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
  });
