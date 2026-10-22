import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { idempotencyRequestHash, requireIdempotencyKey } from "../../utils/idempotency.js";
import { checkApproval, decryptImportHandoff, encryptImportHandoff, validateStaffImport } from "./staffImport.service.js";
import { insertStaffAccount, prepareStaffCredentials } from "./user.creation.js";
import { dispatchStaffSecurityNotification } from "../staffNotifications/staffSecurityEmail.service.js";

export const STAFF_IMPORT_BATCH_SIZE = 50;
const day = 24 * 60 * 60_000;
const activeStatuses = ["QUEUED", "PROCESSING"];
const context = job => `${job.userId}:${job.importId}`;
const availableLease = now => ({ OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] });
export const importJobSelect = { importId: true, status: true, totalCount: true, processedCount: true, createdCount: true, failedCount: true, lastError: true, createdAt: true, updatedAt: true, expiresAt: true };
const publicJob = job => Object.fromEntries(Object.keys(importJobSelect).map(key => [key, job[key]]));

async function ownedJob(userId, importId, database) {
  const job = await database.staffImportJob.findUnique({ where: { importId } });
  if (!job || job.userId !== userId || new Date(job.expiresAt) <= new Date()) throw new AppError(404, "STAFF_IMPORT_NOT_FOUND", "This import is unavailable or its saved results have expired.");
  return job;
}

export async function startStaffImport(req, database = prisma) {
  const { rows, approvalId, confirmed } = req.validatedBody;
  if (confirmed !== true || requireIdempotencyKey(req, "staff import") !== approvalId) throw new AppError(400, "STAFF_IMPORT_CONFIRMATION", "Confirm the reviewed import using its original approval key.");
  const userId = req.auth.userId;
  const requestHash = idempotencyRequestHash(rows);
  const existing = await database.staffImportJob.findUnique({ where: { importId: approvalId } });
  if (existing) {
    await ownedJob(userId, approvalId, database);
    if (existing.requestHash !== requestHash) throw new AppError(409, "STAFF_IMPORT_CHANGED", "The rows changed after confirmation. Review the updated file.");
    return { ...publicJob(existing), replayed: true };
  }
  const where = { userId_operation_idempotencyKey: { userId, operation: "STAFF_IMPORT", idempotencyKey: approvalId } };
  try {
    return await database.$transaction(async tx => {
      const approval = await tx.idempotencyRecord.findUnique({ where });
      checkApproval(approval, rows);
      if (approval.responseStatus !== 200) throw new AppError(409, "STAFF_IMPORT_ALREADY_STARTED", "This review has already been confirmed. Open the existing import result.");
      const job = await tx.staffImportJob.create({ data: {
        importId: approvalId, userId, requestHash, totalCount: rows.length,
        encryptedRows: encryptImportHandoff(rows, `${userId}:${approvalId}`),
        ipAddress: clientIpAddress(req), expiresAt: new Date(Date.now() + 7 * day),
      } });
      await tx.idempotencyRecord.update({ where, data: { responseStatus: 202, responseBody: { importId: approvalId } } });
      await tx.auditLog.create({ data: { userId, action: "STAFF_IMPORT_STARTED", entityAffected: "USER", recordId: approvalId, ipAddress: clientIpAddress(req), details: { totalCount: rows.length } } });
      return { ...publicJob(job), replayed: false };
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (["P2002", "P2034"].includes(error.code)) {
      const concurrent = await database.staffImportJob.findUnique({ where: { importId: approvalId } });
      if (concurrent?.userId === userId && concurrent.requestHash === requestHash) return { ...publicJob(concurrent), replayed: true };
      throw new AppError(409, "STAFF_IMPORT_CONCURRENT", "Another confirmation is in progress. Retry the same confirmation.");
    }
    throw error;
  }
}

export async function listStaffImports(userId, database = prisma) {
  return database.staffImportJob.findMany({ where: { userId, expiresAt: { gt: new Date() } }, select: importJobSelect, orderBy: { createdAt: "desc" }, take: 20 });
}

export async function getStaffImport(userId, importId, database = prisma) {
  return publicJob(await ownedJob(userId, importId, database));
}

export async function getStaffImportResults(userId, importId, database = prisma) {
  const job = await ownedJob(userId, importId, database);
  if (activeStatuses.includes(job.status)) throw new AppError(409, "STAFF_IMPORT_PROCESSING", "Wait for this import to finish before downloading its results.");
  const batches = await database.staffImportBatch.findMany({ where: { importId }, orderBy: { batchIndex: "asc" } });
  const accounts = [];
  const failures = [];
  for (const batch of batches) {
    const result = decryptImportHandoff(batch.encryptedResult, `${context(job)}:${batch.batchIndex}`);
    accounts.push(...result.accounts);
    failures.push(...result.failures);
  }
  return { ...publicJob(job), accounts, failures };
}

export async function resumeStaffImport(userId, importId, database = prisma) {
  const job = await ownedJob(userId, importId, database);
  if (job.status === "FAILED") await database.staffImportJob.updateMany({ where: { importId, userId, status: "FAILED" }, data: { status: "QUEUED", processingToken: null, leaseUntil: null, lastError: null, expiresAt: new Date(Date.now() + 7 * day) } });
  return getStaffImport(userId, importId, database);
}

export async function claimStaffImport(database = prisma, now = new Date()) {
  const where = { status: { in: activeStatuses }, expiresAt: { gt: now }, ...availableLease(now) };
  const candidate = await database.staffImportJob.findFirst({ where, orderBy: { createdAt: "asc" } });
  if (!candidate) return null;
  const processingToken = randomUUID();
  const leaseUntil = new Date(now.getTime() + 120_000);
  const claimed = await database.staffImportJob.updateMany({ where: { ...where, importId: candidate.importId, processedCount: candidate.processedCount }, data: { status: "PROCESSING", processingToken, leaseUntil, lastError: null } });
  return claimed.count === 1 ? { ...candidate, status: "PROCESSING", processingToken, leaseUntil } : null;
}

// Accounts, encrypted credentials and the batch checkpoint commit together.
export async function processStaffImportBatch(job, database = prisma, { prepare = prepareStaffCredentials, insert = insertStaffAccount, dispatch = dispatchStaffSecurityNotification } = {}) {
  const claim = { importId: job.importId, processingToken: job.processingToken };
  try {
    const rows = decryptImportHandoff(job.encryptedRows, context(job)).slice(job.processedCount, job.processedCount + STAFF_IMPORT_BATCH_SIZE);
    const review = await validateStaffImport(rows, database);
    const credentials = new Map();
    for (const row of review.rows.filter(row => !row.issues.length)) credentials.set(row.sourceRow, await prepare(row));
    const committed = await database.$transaction(async tx => {
      const currentJob = await tx.staffImportJob.findUnique({ where: { importId: job.importId } });
      if (currentJob?.processingToken !== job.processingToken || currentJob.processedCount !== job.processedCount || new Date(currentJob.leaseUntil) <= new Date()) return null;
      const actor = await tx.user.findUnique({ where: { userId: job.userId }, select: { role: true, isActive: true, archivedAt: true } });
      if (!actor?.isActive || actor.archivedAt || actor.role !== "SYSTEM_ADMIN") throw new AppError(403, "STAFF_IMPORT_ACCESS_CHANGED", "The administrator account is no longer authorized. Restore access before resuming this import.");
      const current = await validateStaffImport(rows, tx);
      const accounts = [];
      const failures = [];
      const notifications = [];
      const req = { auth: { userId: job.userId }, ip: job.ipAddress };
      for (const row of current.rows) {
        const credential = credentials.get(row.sourceRow);
        if (row.issues.length || !credential) {
          failures.push({ ...row, issues: row.issues.length ? row.issues : ["This record changed during processing. Review and import it again."] });
          continue;
        }
        const { user, securityNotification } = await insert(tx, req, row.record, credential.passwordHash, job.importId);
        accounts.push({ sourceRow: row.sourceRow, user, temporaryPassword: credential.temporaryPassword });
        notifications.push(securityNotification);
      }
      const batchIndex = Math.floor(job.processedCount / STAFF_IMPORT_BATCH_SIZE);
      await tx.staffImportBatch.create({ data: { importId: job.importId, batchIndex, encryptedResult: encryptImportHandoff({ accounts, failures }, `${context(job)}:${batchIndex}`) } });
      const processedCount = job.processedCount + rows.length;
      const complete = processedCount === job.totalCount;
      const updated = await tx.staffImportJob.update({ where: { importId: job.importId }, data: {
        processedCount, createdCount: { increment: accounts.length }, failedCount: { increment: failures.length },
        status: complete ? "COMPLETED" : "PROCESSING", processingToken: null, leaseUntil: null,
        ...(complete ? { encryptedRows: null, expiresAt: new Date(Date.now() + day) } : {}),
      } });
      if (complete) await tx.auditLog.create({ data: { userId: job.userId, action: "STAFF_IMPORT_COMPLETED", entityAffected: "USER", recordId: job.importId, ipAddress: job.ipAddress, details: { createdCount: updated.createdCount, failedCount: updated.failedCount } } });
      return { notifications, result: publicJob(updated) };
    }, { isolationLevel: "Serializable", timeout: 30_000 });
    if (!committed) return null;
    await Promise.allSettled(committed.notifications.map(notification => dispatch(notification)));
    return committed.result;
  } catch (error) {
    const conflict = ["P2002", "P2034"].includes(error.code);
    await database.staffImportJob.updateMany({ where: claim, data: {
      status: "FAILED", processingToken: null, leaseUntil: null, expiresAt: new Date(Date.now() + day),
      lastError: error.code === "STAFF_IMPORT_ACCESS_CHANGED" ? error.message : conflict
        ? "Staff records changed while this batch was being saved. Resume to check the remaining records again."
        : "Processing stopped before the next batch was saved. Completed accounts are retained. Resume to continue.",
    } });
    return null;
  }
}
