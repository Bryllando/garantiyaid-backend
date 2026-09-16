import { randomUUID } from "node:crypto";
import prisma from "../lib/prisma.js";
import { AppError } from "./AppError.js";
import { idempotencyRequestHash, requireIdempotencyKey, saveIdempotencyRecord } from "./idempotency.js";

// Existing SQL constraints allow 200–599. Preview is 200; execution is 201/202.
const READY = 200;

export async function prepareAssistantApproval(userId, operation, payload, preview = {}, database = prisma, now = new Date()) {
  const approvalId = randomUUID();
  const approvalExpiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  await saveIdempotencyRecord({
    identity: { userId, operation, idempotencyKey: approvalId },
    requestHash: idempotencyRequestHash(payload), responseStatus: READY,
    responseBody: { approvalExpiresAt, preview }, now,
  }, database);
  return { approvalId, approvalExpiresAt };
}

// Approval and result share one row. Business writes and the final result commit
// together; an expired/missing row can never reconstruct permission to execute.
export async function executeAssistantApproval(req, operation, payload, execute, database = prisma, now = new Date()) {
  const { approvalId, confirmed } = req.validatedBody;
  if (confirmed !== true) throw new AppError(400, "ASSISTANT_CONFIRMATION_REQUIRED", "Review and explicitly confirm this action.");
  if (requireIdempotencyKey(req, "assistant confirmation") !== approvalId) throw new AppError(409, "ASSISTANT_APPROVAL_KEY_MISMATCH", "Retry using the same preview approval key.");
  const identity = { userId: req.auth.userId, operation, idempotencyKey: approvalId };
  try {
    return await database.$transaction(async (tx) => {
      const record = await tx.idempotencyRecord.findUnique({ where: { userId_operation_idempotencyKey: identity } });
      if (!record || new Date(record.expiresAt) <= now) throw new AppError(409, "ASSISTANT_APPROVAL_EXPIRED", "This approval is unavailable or expired. Check existing distribution or delivery records before preparing another preview.");
      if (record.requestHash !== idempotencyRequestHash(payload)) throw new AppError(409, "ASSISTANT_PREVIEW_CHANGED", "The details differ from the reviewed preview. Review a new preview.");
      if (record.responseStatus !== READY) return { responseStatus: record.responseStatus, responseBody: record.responseBody, replayed: true };
      if (new Date(record.responseBody.approvalExpiresAt) <= now) throw new AppError(409, "ASSISTANT_APPROVAL_EXPIRED", "The preview expired. Review a new preview before submitting.");
      const result = await execute(tx, record.responseBody.preview);
      result.responseBody.data.approvalId = approvalId;
      await tx.idempotencyRecord.update({
        where: { userId_operation_idempotencyKey: identity },
        data: { responseStatus: result.responseStatus, responseBody: JSON.parse(JSON.stringify(result.responseBody)) },
      });
      return { ...result, replayed: false };
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error.code === "P2034" || error.code === "P2002") throw new AppError(409, "ASSISTANT_CONCURRENT_CHANGE", "Another request is finishing. Retry this same approval to retrieve its result.");
    throw error;
  }
}
