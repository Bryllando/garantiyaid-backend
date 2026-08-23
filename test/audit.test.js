import test from "node:test";
import assert from "node:assert/strict";
import auditLogRoutes from "../src/modules/audit/audit.routes.js";
import {
  AUDIT_LOG_READ_ROLES,
  assertAuditLogReadAllowed,
} from "../src/modules/audit/audit.policy.js";
import {
  auditLogIdSchema,
  auditLogListQuerySchema,
} from "../src/modules/audit/audit.schemas.js";
import {
  auditLogPublicSelect,
  buildAuditLogWhere,
  sanitizeAuditDetails,
  sanitizeAuditLog,
} from "../src/modules/audit/audit.service.js";

const auditId = "11111111-1111-4111-8111-111111111111";
const recordId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";

test("only System Administrators and DSWD Staff can read global audit logs", () => {
  assert.deepEqual(AUDIT_LOG_READ_ROLES, ["SYSTEM_ADMIN", "DSWD_STAFF"]);
  assert.doesNotThrow(() => assertAuditLogReadAllowed({ role: "SYSTEM_ADMIN" }));
  assert.doesNotThrow(() => assertAuditLogReadAllowed({ role: "DSWD_STAFF" }));
  assert.throws(
    () => assertAuditLogReadAllowed({ role: "BARANGAY_FACILITATOR" }),
    (error) => error.statusCode === 403 && error.code === "FORBIDDEN",
  );
});

test("audit log filters normalize values and validate pagination and date ranges", () => {
  const query = auditLogListQuerySchema.parse({
    page: "2",
    pageSize: "25",
    action: " beneficiary_document_rejected ",
    entityAffected: " beneficiary_document ",
    recordId,
    userId,
    dateFrom: "2026-08-01T00:00:00Z",
    dateTo: "2026-08-31T23:59:59+08:00",
  });

  assert.equal(query.page, 2);
  assert.equal(query.pageSize, 25);
  assert.equal(query.action, "BENEFICIARY_DOCUMENT_REJECTED");
  assert.equal(query.entityAffected, "BENEFICIARY_DOCUMENT");
  assert.equal(query.dateFrom.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(query.dateTo.toISOString(), "2026-08-31T15:59:59.000Z");
  assert.equal(auditLogIdSchema.safeParse({ auditId }).success, true);
  assert.equal(auditLogListQuerySchema.safeParse({ page: 0 }).success, false);
  assert.equal(auditLogListQuerySchema.safeParse({ pageSize: 101 }).success, false);
  assert.equal(auditLogListQuerySchema.safeParse({
    dateFrom: "2026-08-02T00:00:00Z",
    dateTo: "2026-08-01T00:00:00Z",
  }).success, false);
});

test("audit log filters build an exact, inclusive Prisma query", () => {
  const dateFrom = new Date("2026-08-01T00:00:00.000Z");
  const dateTo = new Date("2026-08-31T23:59:59.999Z");

  assert.deepEqual(buildAuditLogWhere({
    action: "BENEFICIARY_DOCUMENT_ACCEPTED",
    entityAffected: "BENEFICIARY_DOCUMENT",
    recordId,
    userId,
    dateFrom,
    dateTo,
  }), {
    action: "BENEFICIARY_DOCUMENT_ACCEPTED",
    entityAffected: "BENEFICIARY_DOCUMENT",
    recordId,
    userId,
    createdAt: { gte: dateFrom, lte: dateTo },
  });
  assert.deepEqual(buildAuditLogWhere({}), {});
});

test("audit responses recursively redact credentials, tokens, secrets, and document paths", () => {
  const details = {
    safeValue: "visible",
    passwordHash: "do-not-return",
    nested: {
      totpSecret: "do-not-return",
      accessToken: "do-not-return",
      document: {
        filePath: "uploads/private.pdf",
        originalFileName: "proof.pdf",
      },
    },
    values: [
      { authorization: "Bearer do-not-return" },
      "header.payload.signature",
      "ordinary value",
    ],
  };

  assert.deepEqual(sanitizeAuditDetails(details), {
    safeValue: "visible",
    passwordHash: "[REDACTED]",
    nested: {
      totpSecret: "[REDACTED]",
      accessToken: "[REDACTED]",
      document: {
        filePath: "[REDACTED]",
        originalFileName: "proof.pdf",
      },
    },
    values: [
      { authorization: "[REDACTED]" },
      "[REDACTED]",
      "ordinary value",
    ],
  });

  const sanitized = sanitizeAuditLog({ auditId, details });
  assert.equal(sanitized.details.passwordHash, "[REDACTED]");
  assert.equal(details.passwordHash, "do-not-return");
});

test("audit user selection exposes identity only and excludes authentication/contact fields", () => {
  assert.deepEqual(auditLogPublicSelect.user.select, {
    userId: true,
    employeeId: true,
    username: true,
    fullName: true,
    role: true,
  });
  for (const sensitiveField of [
    "passwordHash",
    "totpSecret",
    "email",
    "contactNumber",
    "barangay",
  ]) {
    assert.equal(Object.hasOwn(auditLogPublicSelect.user.select, sensitiveField), false);
  }
});

test("audit API route surface is strictly read-only", () => {
  const routeMethods = auditLogRoutes.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods));

  assert.deepEqual(routeMethods, ["get", "get"]);
  for (const mutationMethod of ["post", "put", "patch", "delete"]) {
    assert.equal(routeMethods.includes(mutationMethod), false);
  }
});
