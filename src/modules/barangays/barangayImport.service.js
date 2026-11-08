import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { idempotencyRequestHash, requireIdempotencyKey } from "../../utils/idempotency.js";
import { createBarangaySchema } from "./barangay.schemas.js";
import { barangaySelect } from "./barangay.service.js";

const operation = "BARANGAY_IMPORT";
const lower = value => (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const locationKey = row => JSON.stringify([row.barangayName, row.city, row.province].map(lower));
const labels = { barangayName: "Barangay name", barangayCode: "Barangay code", city: "City / Municipality", province: "Province" };

export async function validateBarangayImport(rows, database = prisma) {
  const existing = await database.barangay.findMany({ select: barangaySelect });
  const codes = new Set(existing.map(row => lower(row.barangayCode)).filter(Boolean));
  const locations = new Set(existing.map(locationKey));
  const fileCodes = new Map();
  const fileLocations = new Map();
  for (const row of rows) {
    const code = lower(row.barangayCode);
    if (code) fileCodes.set(code, (fileCodes.get(code) ?? 0) + 1);
    const location = locationKey(row);
    fileLocations.set(location, (fileLocations.get(location) ?? 0) + 1);
  }
  const checked = rows.map(({ sourceRow, ...input }) => {
    const parsed = createBarangaySchema.safeParse(input);
    const issues = parsed.success ? [] : parsed.error.issues.map(issue => `${labels[issue.path[0]] ?? "Record"}: ${issue.message}`);
    const code = lower(input.barangayCode);
    const location = locationKey(input);
    if (code && fileCodes.get(code) > 1) issues.push("Barangay code appears more than once in this file.");
    if (fileLocations.get(location) > 1) issues.push("This barangay, city/municipality and province appear more than once in this file.");
    if (code && codes.has(code)) issues.push("Barangay code belongs to an existing record, including inactive barangays.");
    if (locations.has(location)) issues.push("This barangay already exists in the same city/municipality and province. Check the existing record instead.");
    return { sourceRow, record: parsed.success ? parsed.data : input, issues };
  });
  return { rows: checked, validCount: checked.filter(row => !row.issues.length).length, invalidCount: checked.filter(row => row.issues.length).length };
}

export async function previewBarangayImport(userId, rows, database = prisma) {
  const review = await validateBarangayImport(rows, database);
  if (review.invalidCount) return review;
  const approvalId = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  await database.idempotencyRecord.create({ data: {
    userId, operation, idempotencyKey: approvalId, requestHash: idempotencyRequestHash(rows),
    responseStatus: 200, responseBody: {}, expiresAt,
  } });
  return { ...review, approvalId, expiresAt: expiresAt.toISOString() };
}

export async function confirmBarangayImport(req, database = prisma) {
  const { rows, approvalId, confirmed } = req.validatedBody;
  if (confirmed !== true || requireIdempotencyKey(req, "barangay import") !== approvalId) throw new AppError(400, "BARANGAY_IMPORT_CONFIRMATION", "Confirm the reviewed import using its original approval key.");
  const identity = { userId: req.auth.userId, operation, idempotencyKey: approvalId };
  const where = { userId_operation_idempotencyKey: identity };
  try {
    return await database.$transaction(async tx => {
      const approval = await tx.idempotencyRecord.findUnique({ where });
      if (!approval || new Date(approval.expiresAt) <= new Date()) throw new AppError(409, "BARANGAY_IMPORT_EXPIRED", "This review expired. Check the barangay list, then review the file again.");
      if (approval.requestHash !== idempotencyRequestHash(rows)) throw new AppError(409, "BARANGAY_IMPORT_CHANGED", "The rows changed after review. Review the updated file before importing.");
      if (approval.responseStatus === 201) return { ...approval.responseBody, replayed: true };
      const review = await validateBarangayImport(rows, tx);
      if (review.invalidCount) throw new AppError(409, "BARANGAY_IMPORT_INVALID", "Barangay records changed after review. Review again; no barangays were added by this request.", review);
      const barangays = [];
      for (const row of review.rows) {
        const barangay = await tx.barangay.create({ data: row.record, select: barangaySelect });
        barangays.push({ sourceRow: row.sourceRow, barangay });
        await tx.auditLog.create({ data: {
          userId: req.auth.userId, action: "BARANGAY_CREATED", entityAffected: "BARANGAY",
          recordId: barangay.barangayId, ipAddress: clientIpAddress(req), details: { importId: approvalId, sourceRow: row.sourceRow },
        } });
      }
      const result = { importId: approvalId, createdCount: barangays.length, barangays };
      await tx.auditLog.create({ data: { userId: req.auth.userId, action: "BARANGAY_IMPORT_COMPLETED", entityAffected: "BARANGAY", recordId: approvalId, ipAddress: clientIpAddress(req), details: { createdCount: barangays.length } } });
      await tx.idempotencyRecord.update({ where, data: { responseStatus: 201, responseBody: JSON.parse(JSON.stringify(result)), expiresAt: new Date(Date.now() + 24 * 60 * 60_000) } });
      return { ...result, replayed: false };
    }, { isolationLevel: "Serializable", timeout: 30_000 });
  } catch (error) {
    if (["P2002", "P2034"].includes(error.code)) throw new AppError(409, "BARANGAY_IMPORT_CONCURRENT", "Another request changed the barangay list. Retry this confirmation to retrieve its result, or review the list again.");
    throw error;
  }
}
