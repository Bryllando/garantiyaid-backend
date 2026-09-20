import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import prisma from "../lib/prisma.js";
import { AppError } from "./AppError.js";

const idempotencyKeySchema = z.uuid();

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function requireIdempotencyKey(req, operationLabel) {
  const rawKey = req.get("idempotency-key");
  if (!rawKey) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      `An Idempotency-Key UUID header is required for ${operationLabel}.`,
    );
  }
  const parsed = idempotencyKeySchema.safeParse(rawKey.trim());
  if (!parsed.success) {
    throw new AppError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be a valid UUID.");
  }
  return parsed.data;
}

export function idempotencyRequestHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

export function assertIdempotencyRequestMatches(record, requestHash) {
  if (record.requestHash !== requestHash) {
    throw new AppError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used with different request details.",
    );
  }
}

export async function findIdempotencyRecord(identity, database = prisma) {
  const record = await database.idempotencyRecord.findUnique({
    where: { userId_operation_idempotencyKey: identity },
  });
  if (!record) return null;
  if (record.expiresAt > new Date()) return record;
  await database.idempotencyRecord.deleteMany({
    where: { idempotencyRecordId: record.idempotencyRecordId, expiresAt: { lte: new Date() } },
  });
  return null;
}

export async function saveIdempotencyRecord(
  { identity, requestHash, responseStatus, responseBody, now = new Date() },
  database = prisma,
) {
  return database.idempotencyRecord.create({
    data: {
      ...identity,
      requestHash,
      responseStatus,
      responseBody: JSON.parse(JSON.stringify(responseBody)),
      expiresAt: new Date(now.getTime() + env.idempotencyTtlHours * 60 * 60 * 1_000),
    },
  });
}
