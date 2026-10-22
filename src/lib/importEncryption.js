import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

function handoffKey() {
  if (!env.fieldEncryptionKey) throw new AppError(503, "IMPORT_CONFIGURATION", "Import data protection is not configured.");
  return Buffer.from(env.fieldEncryptionKey, "hex");
}

// Store only an encrypted, short-lived handoff so retrying a lost response is safe.
export function encryptImportHandoff(data, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", handoffKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString("base64url")).join(".");
}

export function decryptImportHandoff(value, context) {
  const [iv, tag, ciphertext] = value.split(".").map(part => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", handoffKey(), iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
}

