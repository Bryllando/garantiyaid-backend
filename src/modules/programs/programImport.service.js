import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { idempotencyRequestHash } from "../../utils/idempotency.js";
import { encryptImportHandoff } from "../../lib/importEncryption.js";
import { createProgramSchema } from "./program.schemas.js";
import { PROGRAM_MANAGE_ROLES } from "./program.policy.js";
import { assertProgramDetailsValid } from "./program.service.js";

const labels = { programName: "Program name", programCode: "Program code", programType: "Program type", description: "Description", grantAmount: "Grant amount", budgetAmount: "Budget", applicationStartDate: "Application start date", applicationEndDate: "Application end date", requiredDocumentTypes: "Required documents" };
export function assertProgramImportAccess(actor) {
  if (!actor?.isActive || actor.archivedAt || !PROGRAM_MANAGE_ROLES.includes(actor.role)) throw new AppError(403, "PROGRAM_IMPORT_ACCESS_CHANGED", "Your account is no longer authorized to import programs.");
}

// Preserve exact decimal cents and reject values the database would round or overflow.
export function importMoney(value, field) {
  if (value == null || value.trim() === "") return null;
  const text = value.trim().replace(/^(?:PHP|₱)\s*/i, "");
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) throw new Error(`${labels[field]}: Use a non-negative amount with up to two decimal places, for example 1,500.00.`);
  const [whole, fraction = ""] = text.replaceAll(",", "").split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  const max = field === "grantAmount" ? 999_999_999_999n : 99_999_999_999_999n;
  if (cents > max) throw new Error(`${labels[field]}: Amount exceeds the supported limit (${field === "grantAmount" ? "9,999,999,999.99" : "999,999,999,999.99"}).`);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

export async function validateProgramImport(rows, actor, database = prisma) {
  assertProgramImportAccess(actor);
  const checked = rows.map(({ sourceRow, ...input }) => {
    const issues = [];
    const amounts = {};
    for (const field of ["grantAmount", "budgetAmount"]) {
      try { amounts[field] = importMoney(input[field], field); }
      catch (error) { issues.push(error.message); amounts[field] = null; }
    }
    const parsed = createProgramSchema.safeParse({ ...input, ...amounts });
    if (!parsed.success) issues.push(...parsed.error.issues.map(issue => `${labels[issue.path[0]] ?? "Record"}: ${issue.message}`));
    const record = parsed.success ? { ...parsed.data, ...amounts, requiredDocumentTypes: parsed.data.requiredDocumentTypes ?? [] } : input;
    if (parsed.success && !issues.length) {
      try { assertProgramDetailsValid(record); } catch (error) { issues.push(error.message); }
    }
    return { sourceRow, record, issues };
  });
  const code = row => String(row.record.programCode).trim().toUpperCase();
  const counts = new Map();
  for (const row of checked) counts.set(code(row), (counts.get(code(row)) ?? 0) + 1);
  const existing = await database.program.findMany({ where: { programCode: { in: [...counts.keys()], mode: "insensitive" } }, select: { programCode: true } });
  const existingCodes = new Set(existing.map(row => row.programCode.toUpperCase()));
  for (const row of checked) {
    if (counts.get(code(row)) > 1) row.issues.push("Program code appears more than once in this file. Give each program its own code.");
    if (existingCodes.has(code(row))) row.issues.push("Program code already exists. Check the existing program; it will not be overwritten.");
  }
  return { rows: checked, validCount: checked.filter(row => !row.issues.length).length, invalidCount: checked.filter(row => row.issues.length).length };
}

export async function previewProgramImport(actor, rows, database = prisma) {
  const review = await validateProgramImport(rows, actor, database);
  if (review.invalidCount) return review;
  const approvalId = randomUUID();
  encryptImportHandoff({}, `program:${actor.userId}:${approvalId}`);
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  await database.idempotencyRecord.create({ data: {
    userId: actor.userId, operation: "PROGRAM_IMPORT", idempotencyKey: approvalId,
    requestHash: idempotencyRequestHash(rows), responseStatus: 200, responseBody: {}, expiresAt,
  } });
  return { ...review, approvalId, expiresAt: expiresAt.toISOString() };
}

export function checkProgramImportApproval(approval, rows) {
  if (!approval || new Date(approval.expiresAt) <= new Date()) throw new AppError(409, "PROGRAM_IMPORT_EXPIRED", "This review expired. Review the file again before importing.");
  if (approval.requestHash !== idempotencyRequestHash(rows)) throw new AppError(409, "PROGRAM_IMPORT_CHANGED", "The rows changed after review. Review the updated file.");
}

export async function insertImportedProgram(tx, job, row) {
  const program = await tx.program.create({ data: { ...row.record, status: "DRAFT", createdById: job.userId }, select: { programId: true, programName: true, programCode: true, programType: true, status: true } });
  await tx.auditLog.create({ data: { userId: job.userId, action: "PROGRAM_CREATED", entityAffected: "PROGRAM", recordId: program.programId, ipAddress: job.ipAddress, details: { source: "PROGRAM_IMPORT", importId: job.importId, sourceRow: row.sourceRow, programCode: program.programCode, status: "DRAFT" } } });
  return { sourceRow: row.sourceRow, program };
}
