import "dotenv/config";
import bcrypt from "bcrypt";
import prisma from "../src/lib/prisma.js";
import { newStaffPasswordSchema } from "../src/modules/auth/password.schemas.js";

const requiredValues = [
  "INITIAL_ADMIN_EMPLOYEE_ID",
  "INITIAL_ADMIN_USERNAME",
  "INITIAL_ADMIN_FULL_NAME",
  "INITIAL_ADMIN_EMAIL",
  "INITIAL_ADMIN_PASSWORD",
];

const missingValues = requiredValues.filter((name) => !process.env[name]?.trim());

if (missingValues.length > 0) {
  console.error(`Missing required environment values: ${missingValues.join(", ")}`);
  process.exitCode = 1;
} else {
  try {
    const passwordResult = newStaffPasswordSchema.safeParse(process.env.INITIAL_ADMIN_PASSWORD);
    if (!passwordResult.success) {
      throw new Error("INITIAL_ADMIN_PASSWORD does not meet the staff password policy.");
    }

    const existingAdmin = await prisma.user.findFirst({
      where: { role: "SYSTEM_ADMIN" },
      select: { userId: true, email: true },
    });

    if (existingAdmin) {
      console.log(`A system administrator already exists (${existingAdmin.email}); no account was created.`);
    } else {
      const passwordHash = await bcrypt.hash(passwordResult.data, 12);
      const admin = await prisma.user.create({
        data: {
          employeeId: process.env.INITIAL_ADMIN_EMPLOYEE_ID.trim().toUpperCase(),
          username: process.env.INITIAL_ADMIN_USERNAME.trim().toLowerCase(),
          fullName: process.env.INITIAL_ADMIN_FULL_NAME.trim(),
          email: process.env.INITIAL_ADMIN_EMAIL.trim().toLowerCase(),
          passwordHash,
          role: "SYSTEM_ADMIN",
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: admin.userId,
          action: "INITIAL_SYSTEM_ADMIN_CREATED",
          entityAffected: "USER",
          recordId: admin.userId,
        },
      });

      console.log("Initial system administrator created. Complete TOTP enrollment at first login.");
    }
  } catch (error) {
    console.error("Unable to seed the initial system administrator.");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
