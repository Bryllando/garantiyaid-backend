import bcrypt from "bcrypt";
import prisma from "../src/lib/prisma.js";
import { env } from "../src/config/env.js";
import { assertDevAdminAccount, devAdminConfigurationError, DEV_ADMIN_EMAIL, DEV_ADMIN_EMPLOYEE_ID, DEV_ADMIN_USERNAME } from "../src/modules/auth/devAdmin.policy.js";

try {
  if (!env.devQuickLoginEnabled || devAdminConfigurationError(env)) throw new Error("Enable Developer Admin login only for your explicitly designated local demo database first.");
  if (!env.devAdminPassword || env.devAdminPassword.length < 8 || Buffer.byteLength(env.devAdminPassword) > 72) throw new Error("Set a local DEV_ADMIN_PASSWORD of 8–72 bytes before provisioning.");
  const passwordHash = await bcrypt.hash(env.devAdminPassword, 12);
  const created = await prisma.$transaction(async tx => {
    const existing = await tx.user.findMany({ where: { OR: [{ employeeId: DEV_ADMIN_EMPLOYEE_ID }, { username: DEV_ADMIN_USERNAME }, { email: DEV_ADMIN_EMAIL }] } });
    if (existing.length) {
      if (existing.length !== 1) throw new Error("Developer account identifiers conflict. Existing accounts were not changed.");
      assertDevAdminAccount(existing[0]);
      if (!await bcrypt.compare(env.devAdminPassword, existing[0].passwordHash)) throw new Error("The existing Developer Admin password differs; setup will not reset it.");
      return false;
    }
    const user = await tx.user.create({ data: {
      employeeId: DEV_ADMIN_EMPLOYEE_ID, username: DEV_ADMIN_USERNAME, email: DEV_ADMIN_EMAIL,
      fullName: "Developer Admin", passwordHash, role: "SYSTEM_ADMIN", mustChangePassword: false,
    } });
    await tx.auditLog.create({ data: { userId: user.userId, action: "LOCAL_DEVELOPER_ADMIN_CREATED", entityAffected: "USER", recordId: user.userId, details: { localDemoOnly: true } } });
    return true;
  }, { isolationLevel: "Serializable" });
  console.log(created ? "Developer Admin created for local testing. No notifications sent." : "Developer Admin already exists; its password, MFA and status were preserved.");
} catch (error) {
  console.error(error.code ? `Developer Admin setup failed (${error.code}). Check the local database and identifier conflicts.` : error.message);
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
