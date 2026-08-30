import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";

export const MAX_SIGNATURE_BYTES = 256 * 1024;
const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DATA_URL_PREFIX = "data:image/png;base64,";

function encryptionKey() {
  if (!env.fieldEncryptionKey) {
    throw new AppError(503, "SIGNATURE_CONFIGURATION_ERROR", "Signature evidence encryption is not configured on this server.");
  }
  return Buffer.from(env.fieldEncryptionKey, "hex");
}

function signatureAad(claimId, beneficiaryId, distributionId) {
  return Buffer.from(`garantiyaid-signature:${claimId}:${beneficiaryId}:${distributionId}`, "utf8");
}

export function parseSignatureDataUrl(value) {
  if (!value?.startsWith(DATA_URL_PREFIX)) {
    throw new AppError(400, "INVALID_SIGNATURE_IMAGE", "Submit the live signature as a PNG image.");
  }
  const encoded = value.slice(DATA_URL_PREFIX.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new AppError(400, "INVALID_SIGNATURE_IMAGE", "The signature image is not valid base64 data.");
  }
  const image = Buffer.from(encoded, "base64");
  if (image.length > MAX_SIGNATURE_BYTES) {
    throw new AppError(400, "SIGNATURE_IMAGE_TOO_LARGE", "The signature image must be 256 KB or smaller.");
  }
  if (image.length < 128 || !image.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) {
    throw new AppError(400, "INVALID_SIGNATURE_IMAGE", "The signature image content is not a valid PNG capture.");
  }
  return image;
}

export function encryptSignatureImage(image, claimId, beneficiaryId, distributionId) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(signatureAad(claimId, beneficiaryId, distributionId));
  const encrypted = Buffer.concat([cipher.update(image), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), encrypted]);
}

export function decryptSignatureImage(value, claimId, beneficiaryId, distributionId) {
  const stored = Buffer.from(value);
  if (stored.length <= 1 + IV_BYTES + TAG_BYTES || stored[0] !== FORMAT_VERSION) {
    throw new AppError(500, "INVALID_SIGNATURE_EVIDENCE", "Stored signature evidence is invalid.");
  }
  try {
    const iv = stored.subarray(1, 1 + IV_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAAD(signatureAad(claimId, beneficiaryId, distributionId));
    decipher.setAuthTag(stored.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(stored.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    throw new AppError(500, "INVALID_SIGNATURE_EVIDENCE", "Stored signature evidence cannot be decrypted.");
  }
}

export function signatureImageHash(image) {
  return createHash("sha256").update(image).digest("hex");
}

export function signatureEvidenceToResponse(signature) {
  return {
    signatureId: signature.signatureId,
    claimId: signature.claimId,
    capturedById: signature.capturedById,
    imageSha256: signature.imageSha256,
    signatureMethod: signature.signatureMethod,
    pointCount: signature.pointCount,
    signedAt: signature.signedAt,
    evidenceStored: true,
    encryptedAtRest: true,
  };
}
