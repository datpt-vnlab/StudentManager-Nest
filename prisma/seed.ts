import "dotenv/config";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { v4 as uuidv4 } from "uuid";

const connectionString = `${process.env.DATABASE_URL}`;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const adminId = uuidv4();

  // Admin
  await prisma.admin.create({
    data: {
      id: adminId,
      name: "Admin 1",
      email: "admin@gmail.com",
      created_at: new Date(),
    },
  });

  // Settings
  await prisma.setting.create({
    data: {
      id: uuidv4(),
      admin_id: adminId,
      face_id_enabled: true,
      updated_at: new Date(),
    },
  });

  // Face profile
  await prisma.faceProfile.create({
    data: {
      id: uuidv4(),
      admin_id: adminId,
      descriptor: { vector: [0.1, 0.2, 0.3] },
      created_at: new Date(),
    },
  });

  // Students
  await prisma.student.createMany({
    data: [
      {
        id: "SV001",
        password_hash: "hashed_password",
        first_name: "Nguyen",
        last_name: "A",
        email: "a@gmail.com",
        status: "active",
        created_at: new Date(),
      },
      {
        id: "SV002",
        password_hash: "hashed_password",
        first_name: "Tran",
        last_name: "B",
        email: "b@gmail.com",
        status: "inactive",
        created_at: new Date(),
      },
    ],
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
  });
