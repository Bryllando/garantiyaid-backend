import { createHash, randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { STAFF_ROLES } from "./auth.constants.js";

export const PASSWORD_RESET_PUBLIC_MESSAGE = "If the account is eligible, a password-reset link will be sent to its registered email address.";

export function passwordResetLookupWhere(account) {
  const normalized = account.trim();
  return {
    isActive: true,
    archivedAt: null,
    role: { in: STAFF_ROLES },
    OR: [
      { email: normalized.toLowerCase() },
      { employeeId: normalized.toUpperCase() },
      { username: normalized.toLowerCase() },
    ],
  };
}

export function hashPasswordResetToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function generatePasswordResetToken(now = new Date()) {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashPasswordResetToken(token),
    expiresAt: new Date(now.getTime() + env.passwordResetTokenMinutes * 60_000),
  };
}

export function passwordResetTokenIsUsable(record, now = new Date()) {
  return Boolean(
    record
    && !record.usedAt
    && record.expiresAt > now
    && record.user?.isActive
    && !record.user?.archivedAt,
  );
}

export function passwordResetPath(token) {
  return `/reset-password?token=${encodeURIComponent(token)}`;
}
