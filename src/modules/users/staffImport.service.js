import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { encryptImportHandoff, decryptImportHandoff } from "../../lib/importEncryption.js";
export { encryptImportHandoff, decryptImportHandoff } from "../../lib/importEncryption.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { idempotencyRequestHash, requireIdempotencyKey } from "../../utils/idempotency.js";
import { createStaffUserSchema } from "./user.schemas.js";
import { insertStaffAccount, prepareStaffCredentials } from "./user.creation.js";
import { dispatchStaffSecurityNotification } from "../staffNotifications/staffSecurityEmail.service.js";

const operation = "STAFF_IMPORT";
const ttl = 15 * 60_000;
const fieldLabels = { fullName: "Full name", email: "Email", role: "Role", username: "Username", contactNumber: "Contact number", barangayId: "Barangay" };
const lower = value => (value ?? "").trim().toLowerCase();

export async function validateStaffImport(rows, database = prisma) {
  const checked = rows.map(({ sourceRow, ...input }) => {
    const result = createStaffUserSchema.safeParse(input);
    return { sourceRow, record: result.success ? result.data : input,
      issues: result.success ? [] : result.error.issues.map(issue => `${fieldLabels[issue.path[0]] ?? "Record"}: ${issue.message}`) };
  });
  const emails = [...new Set(rows.map(row => lower(row.email)).filter(Boolean))];
  const usernames = [...new Set(rows.map(row => lower(row.username)).filter(Boolean))];
  const barangayIds = checked.filter(row => !row.issues.length).map(row => row.record.barangayId).filter(Boolean);
  const [existing, barangays] = await Promise.all([
    database.user.findMany({ where: { OR: [
      { email: { in: emails, mode: "insensitive" } },
      { username: { in: usernames, mode: "insensitive" } },
      { employeeId: { in: usernames, mode: "insensitive" } },
    ] }, select: { email: true, username: true, employeeId: true } }),
    database.barangay.findMany({ where: { barangayId: { in: barangayIds }, isActive: true }, select: { barangayId: true, barangayName: true, city: true } }),
  ]);
  const activeBarangays = new Map(barangays.map(barangay => [barangay.barangayId, barangay]));
  const emailCounts = new Map();
  const usernameCounts = new Map();
  for (const row of rows) {
    const email = lower(row.email);
    const username = lower(row.username);
    emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
    usernameCounts.set(username, (usernameCounts.get(username) ?? 0) + 1);
  }
  const existingEmails = new Set(existing.map(user => lower(user.email)));
  const existingIdentifiers = new Set(existing.flatMap(user => [lower(user.username), lower(user.employeeId)]));
  for (const row of checked) {
    const email = lower(row.record.email);
    const username = lower(row.record.username);
    if (email && emailCounts.get(email) > 1) row.issues.push("Email appears more than once in this file.");
    if (username && usernameCounts.get(username) > 1) row.issues.push("Username appears more than once in this file.");
    if (email && existingEmails.has(email)) row.issues.push("Email belongs to an existing account, including inactive or archived accounts.");
    if (username && existingIdentifiers.has(username)) row.issues.push("Username is already used as a username or Staff ID.");
    if (row.record.role === "BARANGAY_FACILITATOR") {
      const barangay = activeBarangays.get(row.record.barangayId);
      if (!barangay) row.issues.push("Select an existing, active barangay.");
      else row.barangayLabel = `${barangay.barangayName}, ${barangay.city}`;
    }
  }
  return { rows: checked, validCount: checked.filter(row => !row.issues.length).length, invalidCount: checked.filter(row => row.issues.length).length };
}

export async function previewStaffImport(userId, rows, database = prisma) {
  const review = await validateStaffImport(rows, database);
  if (review.invalidCount) return review;
  encryptImportHandoff({}, `staff:${userId}`);
  const approvalId = randomUUID();
  const expiresAt = new Date(Date.now() + ttl);
  await database.idempotencyRecord.create({ data: {
    userId, operation, idempotencyKey: approvalId, requestHash: idempotencyRequestHash(rows),
    responseStatus: 200, responseBody: {}, expiresAt,
  } });
  return { ...review, approvalId, expiresAt: expiresAt.toISOString() };
}

export function checkApproval(record, rows) {
  if (!record || new Date(record.expiresAt) <= new Date()) throw new AppError(409, "STAFF_IMPORT_EXPIRED", "This import review expired. Check the staff list, then review the file again. For accounts already created, use password recovery if credentials were not saved.");
  if (record.requestHash !== idempotencyRequestHash(rows)) throw new AppError(409, "STAFF_IMPORT_CHANGED", "The rows changed after review. Review the updated list before importing.");
}

export async function confirmStaffImport(req, database = prisma, { prepare = prepareStaffCredentials, insert = insertStaffAccount, dispatch = dispatchStaffSecurityNotification } = {}) {
  const { rows, approvalId, confirmed } = req.validatedBody;
  if (confirmed !== true || requireIdempotencyKey(req, "staff import") !== approvalId) throw new AppError(400, "STAFF_IMPORT_CONFIRMATION", "Confirm the reviewed import using its original approval key.");
  const identity = { userId: req.auth.userId, operation, idempotencyKey: approvalId };
  const where = { userId_operation_idempotencyKey: identity };
  const context = `${identity.userId}:${approvalId}`;
  const existing = await database.idempotencyRecord.findUnique({ where });
  checkApproval(existing, rows);
  if (existing.responseStatus === 201) return { ...decryptImportHandoff(existing.responseBody.handoff, context), replayed: true };
  if (existing.responseStatus !== 200) throw new AppError(409, "STAFF_IMPORT_ALREADY_STARTED", "Open the background import to check its progress and results.");
  const review = await validateStaffImport(rows, database);
  if (review.invalidCount) {
    // A concurrent confirmation may have committed between the approval read and validation.
    const latest = await database.idempotencyRecord.findUnique({ where });
    checkApproval(latest, rows);
    if (latest.responseStatus === 201) return { ...decryptImportHandoff(latest.responseBody.handoff, context), replayed: true };
    throw new AppError(409, "STAFF_IMPORT_INVALID", "Some records are no longer ready. Review the list again; no accounts were created by this request.", review);
  }
  // Hash outside the transaction; keep account, audit and retry-result writes atomic.
  const credentials = [];
  for (const row of rows) credentials.push(await prepare(row));
  let committed;
  try {
    committed = await database.$transaction(async tx => {
      const approval = await tx.idempotencyRecord.findUnique({ where });
      checkApproval(approval, rows);
      if (approval.responseStatus === 201) return { handoff: approval.responseBody.handoff, notifications: [], replayed: true };
      const current = await validateStaffImport(rows, tx);
      if (current.invalidCount) throw new AppError(409, "STAFF_IMPORT_INVALID", "Staff or barangay records changed. Review again; no accounts were created by this request.", current);
      const accounts = [];
      const notifications = [];
      for (const [index, row] of current.rows.entries()) {
        const { user, securityNotification } = await insert(tx, req, row.record, credentials[index].passwordHash, approvalId);
        accounts.push({ sourceRow: row.sourceRow, user, temporaryPassword: credentials[index].temporaryPassword });
        notifications.push(securityNotification);
      }
      const data = { importId: approvalId, accounts, createdCount: accounts.length };
      const handoff = encryptImportHandoff(data, context);
      await tx.auditLog.create({ data: { userId: req.auth.userId, action: "STAFF_IMPORT_COMPLETED", entityAffected: "USER", recordId: approvalId, ipAddress: clientIpAddress(req), details: { importId: approvalId, createdCount: accounts.length } } });
      await tx.idempotencyRecord.update({ where, data: { responseStatus: 201, responseBody: { handoff }, expiresAt: new Date(Date.now() + ttl) } });
      return { handoff, notifications, replayed: false };
    }, { isolationLevel: "Serializable", timeout: 30_000 });
  } catch (error) {
    if (["P2002", "P2034"].includes(error.code)) throw new AppError(409, "STAFF_IMPORT_CONCURRENT", "Another request changed the staff list. Retry this confirmation to retrieve its result, or review the list again.");
    throw error;
  }
  await Promise.allSettled(committed.notifications.map(notification => dispatch(notification)));
  return { ...decryptImportHandoff(committed.handoff, context), replayed: committed.replayed };
}
