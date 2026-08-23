import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";

const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_DETAIL_KEYS = new Set([
  "authorization",
  "cookie",
  "encryptionkey",
  "faceembedding",
  "filepath",
  "otp",
  "otpcode",
  "passcode",
  "password",
  "passwordhash",
  "path",
  "pin",
  "privatekey",
  "sessionid",
  "setcookie",
  "storagepath",
  "storedpath",
  "totp",
  "totpcode",
  "totpsecret",
  "recipient",
  "contactnumber",
  "message",
]);
const SENSITIVE_DETAIL_KEY_FRAGMENTS = Object.freeze([
  "password",
  "secret",
  "token",
  "filepath",
  "storedpath",
  "storagepath",
  "privatekey",
  "encryptionkey",
  "faceembedding",
  "biometrictemplate",
  "recipient",
  "contactnumber",
  "message",
]);

export const auditLogPublicSelect = {
  auditId: true,
  userId: true,
  actorType: true,
  action: true,
  entityAffected: true,
  recordId: true,
  ipAddress: true,
  details: true,
  createdAt: true,
  user: {
    select: {
      userId: true,
      employeeId: true,
      username: true,
      fullName: true,
      role: true,
    },
  },
};

function normalizedDetailKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveDetailKey(key) {
  const normalizedKey = normalizedDetailKey(key);
  return SENSITIVE_DETAIL_KEYS.has(normalizedKey)
    || SENSITIVE_DETAIL_KEY_FRAGMENTS.some((fragment) => normalizedKey.includes(fragment));
}

function isTokenLikeString(value) {
  return /^Bearer\s+\S+/i.test(value)
    || /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

export function sanitizeAuditDetails(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditDetails(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        isSensitiveDetailKey(key) ? REDACTED_VALUE : sanitizeAuditDetails(nestedValue),
      ]),
    );
  }

  if (typeof value === "string" && isTokenLikeString(value)) {
    return REDACTED_VALUE;
  }

  return value;
}

export function sanitizeAuditLog(auditLog) {
  return {
    ...auditLog,
    details: auditLog.details == null ? null : sanitizeAuditDetails(auditLog.details),
  };
}

export function buildAuditLogWhere({
  action,
  entityAffected,
  recordId,
  userId,
  dateFrom,
  dateTo,
}) {
  return {
    ...(action ? { action } : {}),
    ...(entityAffected ? { entityAffected } : {}),
    ...(recordId ? { recordId } : {}),
    ...(userId ? { userId } : {}),
    ...(dateFrom || dateTo ? {
      createdAt: {
        ...(dateFrom ? { gte: dateFrom } : {}),
        ...(dateTo ? { lte: dateTo } : {}),
      },
    } : {}),
  };
}

export async function getAuditLogOrThrow(auditId) {
  const auditLog = await prisma.auditLog.findUnique({
    where: { auditId },
    select: auditLogPublicSelect,
  });

  if (!auditLog) {
    throw new AppError(404, "AUDIT_LOG_NOT_FOUND", "Audit log was not found.");
  }

  return sanitizeAuditLog(auditLog);
}

export async function writeAuditLog({
  userId,
  actorType = "STAFF",
  action,
  entityAffected,
  recordId,
  ipAddress,
  details,
}) {
  return prisma.auditLog.create({
    data: {
      userId,
      actorType,
      action,
      entityAffected,
      recordId,
      ipAddress,
      details,
    },
  });
}
