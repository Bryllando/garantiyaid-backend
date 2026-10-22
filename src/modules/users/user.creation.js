import bcrypt from "bcrypt";
import { clientIpAddress } from "../../utils/clientIp.js";
import { createStaffSecurityNotification } from "../staffNotifications/staffSecurityEmail.service.js";
import { assertStaffLoginIdentifiersAvailable, generateStaffId, generateTemporaryPassword, staffUserSelect } from "./user.service.js";

export async function prepareStaffCredentials() {
  const temporaryPassword = generateTemporaryPassword();
  return { temporaryPassword, passwordHash: await bcrypt.hash(temporaryPassword, 12) };
}

export async function insertStaffAccount(tx, req, input, passwordHash, importId) {
  const employeeId = await generateStaffId(input.role, tx);
  await assertStaffLoginIdentifiersAvailable({ employeeId, username: input.username }, undefined, tx);
  const user = await tx.user.create({ data: { ...input, employeeId, passwordHash }, select: staffUserSelect });
  await tx.auditLog.create({ data: {
    userId: req.auth.userId, action: "STAFF_ACCOUNT_CREATED", entityAffected: "USER",
    recordId: user.userId, ipAddress: clientIpAddress(req),
    details: { role: user.role, staffId: user.employeeId, ...(importId ? { importId } : {}) },
  } });
  const securityNotification = await createStaffSecurityNotification({ event: "ACCOUNT_CREATED", eventKey: user.userId, user }, tx);
  return { user, securityNotification };
}
