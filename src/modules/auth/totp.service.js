import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

function requireEncryptionKey() {
  if (!env.fieldEncryptionKey) {
    throw new AppError(
      503,
      "TOTP_CONFIGURATION_ERROR",
      "TOTP is not configured on this server.",
    );
  }

  return Buffer.from(env.fieldEncryptionKey, "hex");
}

function toBase32(buffer) {
  let bits = "";
  let encoded = "";

  for (const byte of buffer) {
    bits += byte.toString(2).padStart(8, "0");
  }

  for (let index = 0; index + 5 <= bits.length; index += 5) {
    encoded += BASE32_ALPHABET[Number.parseInt(bits.slice(index, index + 5), 2)];
  }

  return encoded;
}

function fromBase32(secret) {
  const normalized = secret.replace(/\s|=/g, "").toUpperCase();
  let bits = "";

  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new AppError(400, "INVALID_TOTP_SECRET", "The TOTP secret is invalid.");
    }
    bits += index.toString(2).padStart(5, "0");
  }

  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }

  return Buffer.from(bytes);
}

function generateCodeForCounter(secret, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", fromBase32(secret))
    .update(counterBuffer)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binaryCode =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binaryCode % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function generateTotpSecret() {
  return toBase32(randomBytes(20));
}

export function createTotpUri({ accountName, secret, issuer = "GarantiyAid" }) {
  const label = `${issuer}:${accountName}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });

  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`;
}

export function verifyTotpCode(secret, candidateCode) {
  return findValidTotpCounter(secret, candidateCode) !== null;
}

export function findValidTotpCounter(secret, candidateCode, timestamp = Date.now()) {
  if (!/^\d{6}$/.test(candidateCode)) {
    return null;
  }

  const currentCounter = Math.floor(timestamp / 1000 / STEP_SECONDS);
  for (let offset = -1; offset <= 1; offset += 1) {
    const counter = currentCounter + offset;
    const expectedCode = generateCodeForCounter(secret, counter);
    if (timingSafeEqual(Buffer.from(expectedCode), Buffer.from(candidateCode))) {
      return BigInt(counter);
    }
  }

  return null;
}

export function encryptTotpSecret(secret) {
  const key = requireEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptTotpSecret(value) {
  const key = requireEncryptionKey();
  const [ivValue, tagValue, encryptedValue] = value.split(".");

  if (!ivValue || !tagValue || !encryptedValue) {
    throw new AppError(500, "INVALID_TOTP_SECRET", "Stored TOTP configuration is invalid.");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
