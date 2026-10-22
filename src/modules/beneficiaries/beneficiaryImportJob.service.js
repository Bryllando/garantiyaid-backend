import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { idempotencyRequestHash, requireIdempotencyKey } from "../../utils/idempotency.js";
import { decryptImportHandoff, encryptImportHandoff } from "../../lib/importEncryption.js";
import { checkBeneficiaryImportApproval, beneficiaryImportScope, validateBeneficiaryImport, insertImportedBeneficiary } from "./beneficiaryImport.service.js";

export const BENEFICIARY_IMPORT_BATCH_SIZE = 50;
const day = 24 * 60 * 60_000;
const activeStatuses = ["QUEUED", "PROCESSING"];
const context = job => `beneficiary:${job.userId}:${job.importId}`;
const availableLease = now => ({ OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] });
export const importJobSelect = { importId: true, status: true, totalCount: true, processedCount: true, createdCount: true, failedCount: true, lastError: true, createdAt: true, updatedAt: true, expiresAt: true };
const publicJob = job => Object.fromEntries(Object.keys(importJobSelect).map(key => [key, job[key]]));

async function ownedJob(actor, importId, database) {
  const userId = actor.userId;
  const scope = beneficiaryImportScope(actor);
  const job = await database.beneficiaryImportJob.findUnique({ where: { importId } });
  if (!job || job.userId !== userId || new Date(job.expiresAt) <= new Date()) throw new AppError(404, "BENEFICIARY_IMPORT_NOT_FOUND", "This import is unavailable or its saved results have expired.");
  if (scope !== null && scope !== job.scopeBarangayId) throw new AppError(403, "BENEFICIARY_IMPORT_ACCESS_CHANGED", "Your current barangay access does not cover this import.");
  return job;
}

export async function startBeneficiaryImport(req, database = prisma) {
  const { rows, approvalId, confirmed } = req.validatedBody;
  if (confirmed !== true || requireIdempotencyKey(req, "beneficiary import") !== approvalId) throw new AppError(400, "BENEFICIARY_IMPORT_CONFIRMATION", "Confirm the reviewed import using its original approval key.");
  const userId = req.auth.userId;
  const scopeBarangayId = beneficiaryImportScope(req.staffUser);
  const requestHash = idempotencyRequestHash(rows);
  const existing = await database.beneficiaryImportJob.findUnique({ where: { importId: approvalId } });
  if (existing) {
    await ownedJob(req.staffUser, approvalId, database);
    if (existing.requestHash !== requestHash) throw new AppError(409, "BENEFICIARY_IMPORT_CHANGED", "The rows changed after confirmation. Review the updated file.");
    return { ...publicJob(existing), replayed: true };
  }
  const where = { userId_operation_idempotencyKey: { userId, operation: "BENEFICIARY_IMPORT", idempotencyKey: approvalId } };
  try {
    return await database.$transaction(async tx => {
      const approval = await tx.idempotencyRecord.findUnique({ where });
      checkBeneficiaryImportApproval(approval, rows, req.staffUser);
      if (approval.responseStatus !== 200) throw new AppError(409, "BENEFICIARY_IMPORT_ALREADY_STARTED", "This review has already been confirmed. Open the existing import result.");
      const job = await tx.beneficiaryImportJob.create({ data: {
        importId: approvalId, userId, scopeBarangayId, requestHash, totalCount: rows.length,
        encryptedRows: encryptImportHandoff(rows, `beneficiary:${userId}:${approvalId}`),
        ipAddress: clientIpAddress(req), expiresAt: new Date(Date.now() + 7 * day),
      } });
      await tx.idempotencyRecord.update({ where, data: { responseStatus: 202, responseBody: { importId: approvalId } } });
      await tx.auditLog.create({ data: { userId, action: "BENEFICIARY_IMPORT_STARTED", entityAffected: "BENEFICIARY", recordId: approvalId, ipAddress: clientIpAddress(req), details: { totalCount: rows.length } } });
      return { ...publicJob(job), replayed: false };
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (["P2002", "P2034"].includes(error.code)) {
      const concurrent = await database.beneficiaryImportJob.findUnique({ where: { importId: approvalId } });
      if (concurrent?.userId === userId && concurrent.requestHash === requestHash) {
        await ownedJob(req.staffUser, approvalId, database);
        return { ...publicJob(concurrent), replayed: true };
      }
      throw new AppError(409, "BENEFICIARY_IMPORT_CONCURRENT", "Another confirmation is in progress. Retry the same confirmation.");
    }
    throw error;
  }
}

export async function listBeneficiaryImports(actor, database = prisma) {
  const scope = beneficiaryImportScope(actor);
  return database.beneficiaryImportJob.findMany({ where: { userId: actor.userId, ...(scope ? { scopeBarangayId: scope } : {}), expiresAt: { gt: new Date() } }, select: importJobSelect, orderBy: { createdAt: "desc" }, take: 20 });
}

export async function getBeneficiaryImport(actor, importId, database = prisma) {
  return publicJob(await ownedJob(actor, importId, database));
}

export async function getBeneficiaryImportResults(actor, importId, database = prisma) {
  const job = await ownedJob(actor, importId, database);
  if (activeStatuses.includes(job.status)) throw new AppError(409, "BENEFICIARY_IMPORT_PROCESSING", "Wait for this import to finish before downloading its results.");
  const batches = await database.beneficiaryImportBatch.findMany({ where: { importId }, orderBy: { batchIndex: "asc" } });
  const beneficiaries = [];
  const failures = [];
  for (const batch of batches) {
    const result = decryptImportHandoff(batch.encryptedResult, `${context(job)}:${batch.batchIndex}`);
    beneficiaries.push(...result.beneficiaries);
    failures.push(...result.failures);
  }
  return { ...publicJob(job), beneficiaries, failures };
}

export async function resumeBeneficiaryImport(actor, importId, database = prisma) {
  const job = await ownedJob(actor, importId, database);
  if (job.status === "FAILED") await database.beneficiaryImportJob.updateMany({ where: { importId, userId: actor.userId, status: "FAILED" }, data: { status: "QUEUED", processingToken: null, leaseUntil: null, lastError: null, expiresAt: new Date(Date.now() + 7 * day) } });
  return getBeneficiaryImport(actor, importId, database);
}

export async function claimBeneficiaryImport(database = prisma, now = new Date()) {
  const where = { status: { in: activeStatuses }, expiresAt: { gt: now }, ...availableLease(now) };
  const candidate = await database.beneficiaryImportJob.findFirst({ where, orderBy: { createdAt: "asc" } });
  if (!candidate) return null;
  const processingToken = randomUUID();
  const leaseUntil = new Date(now.getTime() + 120_000);
  const claimed = await database.beneficiaryImportJob.updateMany({ where: { ...where, importId: candidate.importId, processedCount: candidate.processedCount }, data: { status: "PROCESSING", processingToken, leaseUntil, lastError: null } });
  return claimed.count === 1 ? { ...candidate, status: "PROCESSING", processingToken, leaseUntil } : null;
}

// Beneficiaries, encrypted results and the checkpoint commit together.
export async function processBeneficiaryImportBatch(job, database = prisma, { insert = insertImportedBeneficiary } = {}) {
  const claim = { importId: job.importId, processingToken: job.processingToken };
  try {
    const rows = decryptImportHandoff(job.encryptedRows, context(job)).slice(job.processedCount, job.processedCount + BENEFICIARY_IMPORT_BATCH_SIZE);
    const committed = await database.$transaction(async tx => {
      const currentJob = await tx.beneficiaryImportJob.findUnique({ where: { importId: job.importId } });
      if (currentJob?.processingToken !== job.processingToken || currentJob.processedCount !== job.processedCount || new Date(currentJob.leaseUntil) <= new Date()) return null;
      const actor = await tx.user.findUnique({ where: { userId: job.userId }, select: { userId: true, role: true, barangayId: true, isActive: true, archivedAt: true } });
      const scope = beneficiaryImportScope(actor);
      if (scope !== job.scopeBarangayId) throw new AppError(403, "BENEFICIARY_IMPORT_ACCESS_CHANGED", "Your barangay access changed. Restore the original assignment before resuming this import.");
      const current = await validateBeneficiaryImport(rows, actor, tx);
      const beneficiaries = [];
      const failures = [];
      for (const row of current.rows) {
        if (row.issues.length) { failures.push(row); continue; }
        beneficiaries.push(await insert(tx, job, row));
      }
      const batchIndex = Math.floor(job.processedCount / BENEFICIARY_IMPORT_BATCH_SIZE);
      await tx.beneficiaryImportBatch.create({ data: { importId: job.importId, batchIndex, encryptedResult: encryptImportHandoff({ beneficiaries, failures }, `${context(job)}:${batchIndex}`) } });
      const processedCount = job.processedCount + rows.length;
      const complete = processedCount === job.totalCount;
      const updated = await tx.beneficiaryImportJob.update({ where: { importId: job.importId }, data: {
        processedCount, createdCount: { increment: beneficiaries.length }, failedCount: { increment: failures.length },
        status: complete ? "COMPLETED" : "PROCESSING", processingToken: null, leaseUntil: null,
        ...(complete ? { encryptedRows: null, expiresAt: new Date(Date.now() + day) } : {}),
      } });
      if (complete) await tx.auditLog.create({ data: { userId: job.userId, action: "BENEFICIARY_IMPORT_COMPLETED", entityAffected: "BENEFICIARY", recordId: job.importId, ipAddress: job.ipAddress, details: { createdCount: updated.createdCount, failedCount: updated.failedCount } } });
      return publicJob(updated);
    }, { isolationLevel: "Serializable", timeout: 30_000 });
    return committed;
  } catch (error) {
    const conflict = ["P2002", "P2034"].includes(error.code);
    await database.beneficiaryImportJob.updateMany({ where: claim, data: {
      status: "FAILED", processingToken: null, leaseUntil: null, expiresAt: new Date(Date.now() + day),
      lastError: error.code === "BENEFICIARY_IMPORT_ACCESS_CHANGED" ? error.message : conflict
        ? "Beneficiary records changed while this batch was being saved. Resume to check the remaining records again."
        : "Processing stopped before the next batch was saved. Completed beneficiary records are retained. Resume to continue.",
    } });
    return null;
  }
}
