import { AppError } from "../../utils/AppError.js";

export const AUDIT_LOG_READ_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "DSWD_STAFF",
]);

export function assertAuditLogReadAllowed(staffUser) {
  if (!staffUser || !AUDIT_LOG_READ_ROLES.includes(staffUser.role)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only System Administrators and DSWD Staff may view audit logs.",
    );
  }
}
