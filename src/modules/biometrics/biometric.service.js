import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";

const TEMPLATE_FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SIMULATED_MODEL = "gya-simulated-v1";
const DEEPFACE_MODEL = "ArcFace";
const DEEPFACE_PROCESSOR = "REMOTE_DEEPFACE_ARCFACE";

export const biometricProfilePublicSelect = {
  biometricId: true,
  beneficiaryId: true,
  enrolledById: true,
  consentId: true,
  insightfaceModel: true,
  dataStatus: true,
  livenessScore: true,
  livenessPassed: true,
  verificationCount: true,
  lastVerifiedAt: true,
  createdAt: true,
  updatedAt: true,
};

export const biometricProfileInternalSelect = {
  ...biometricProfilePublicSelect,
  faceEmbedding: true,
  consent: {
    select: {
      consentId: true,
      beneficiaryId: true,
      consentGiven: true,
      consentedAt: true,
      revokedAt: true,
      retentionUntil: true,
    },
  },
};

export const biometricAttemptPublicSelect = {
  attemptId: true,
  distributionId: true,
  beneficiaryId: true,
  biometricId: true,
  claimId: true,
  verifiedById: true,
  result: true,
  matchScore: true,
  livenessScore: true,
  deviceInfo: true,
  processor: true,
  createdAt: true,
};

const duplicateBeneficiarySelect = {
  beneficiaryId: true,
  firstName: true,
  middleName: true,
  lastName: true,
  birthDate: true,
  status: true,
  barangay: { select: { barangayId: true, barangayName: true, city: true } },
};

export const biometricDuplicateCasePublicSelect = {
  duplicateCaseId: true,
  candidateBeneficiaryId: true,
  matchedBeneficiaryId: true,
  candidateBiometricId: true,
  matchedBiometricId: true,
  matchScore: true,
  matchThreshold: true,
  status: true,
  detectedAt: true,
  reviewedAt: true,
  reviewNotes: true,
  candidateBeneficiary: { select: duplicateBeneficiarySelect },
  matchedBeneficiary: { select: duplicateBeneficiarySelect },
  candidateBiometric: {
    select: {
      biometricId: true,
      dataStatus: true,
      consentId: true,
      consent: {
        select: { consentGiven: true, revokedAt: true, retentionUntil: true },
      },
    },
  },
  matchedBiometric: { select: { biometricId: true, dataStatus: true } },
  reviewedBy: {
    select: { userId: true, employeeId: true, fullName: true, role: true },
  },
};

export function consentEffectiveStatus(consent, now = new Date()) {
  if (!consent.consentGiven) return "DECLINED";
  if (consent.revokedAt) return "REVOKED";
  if (consent.retentionUntil <= now) return "EXPIRED";
  return "ACTIVE";
}

export function biometricProfileStatus(profile, now = new Date()) {
  if (!profile) return "NOT_ENROLLED";
  if (profile.dataStatus === "REVOKED" || profile.consent?.revokedAt) return "REVOKED";
  if (
    profile.dataStatus === "EXPIRED"
    || !profile.consent?.consentGiven
    || profile.consent?.retentionUntil <= now
  ) return "EXPIRED";
  if (profile.dataStatus === "PENDING_DUPLICATE_REVIEW") return "PENDING_DUPLICATE_REVIEW";
  if (profile.dataStatus === "DUPLICATE_BLOCKED") return "DUPLICATE_BLOCKED";
  return "ENROLLED";
}

export function biometricDuplicateCaseToResponse(duplicateCase) {
  return {
    ...duplicateCase,
    matchScore: duplicateCase.matchScore.toString(),
    matchThreshold: duplicateCase.matchThreshold.toString(),
  };
}

export function consentToResponse(consent, now = new Date()) {
  return {
    ...consent,
    consentStatus: consentEffectiveStatus(consent, now),
    biometricData: consent.biometricData
      ? {
          biometricId: consent.biometricData.biometricId,
          dataStatus: consent.biometricData.dataStatus,
        }
      : null,
  };
}

export function biometricProfileToResponse(profile, now = new Date()) {
  if (!profile) {
    return {
      biometricStatus: "NOT_ENROLLED",
      rawCaptureStored: false,
      templateReturned: false,
    };
  }
  const { consent, faceEmbedding: ignoredTemplate, ...publicProfile } = profile;
  return {
    ...publicProfile,
    livenessScore: publicProfile.livenessScore?.toString() ?? null,
    biometricStatus: biometricProfileStatus(profile, now),
    consentStatus: consent ? consentEffectiveStatus(consent, now) : "UNAVAILABLE",
    templateEncrypted: true,
    rawCaptureStored: false,
    templateReturned: false,
  };
}

export function biometricAttemptToResponse(attempt) {
  return {
    ...attempt,
    matchScore: attempt.matchScore?.toString() ?? null,
    livenessScore: attempt.livenessScore?.toString() ?? null,
  };
}

function encryptionKey() {
  if (!env.fieldEncryptionKey) {
    throw new AppError(
      503,
      "BIOMETRIC_CONFIGURATION_ERROR",
      "Biometric template encryption is not configured on this server.",
    );
  }
  return Buffer.from(env.fieldEncryptionKey, "hex");
}

function templateAad(beneficiaryId, consentId) {
  return Buffer.from(`garantiyaid-biometric:${beneficiaryId}:${consentId}`, "utf8");
}

export function encryptBiometricTemplate(embedding, beneficiaryId, consentId) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(templateAad(beneficiaryId, consentId));
  const plaintext = Buffer.from(JSON.stringify(embedding), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([
    Buffer.from([TEMPLATE_FORMAT_VERSION]),
    iv,
    cipher.getAuthTag(),
    encrypted,
  ]);
}

export function decryptBiometricTemplate(value, beneficiaryId, consentId) {
  const stored = Buffer.from(value);
  if (stored.length <= 1 + IV_BYTES + TAG_BYTES || stored[0] !== TEMPLATE_FORMAT_VERSION) {
    throw new AppError(500, "INVALID_BIOMETRIC_TEMPLATE", "Stored biometric template is invalid.");
  }
  const iv = stored.subarray(1, 1 + IV_BYTES);
  const tag = stored.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const encrypted = stored.subarray(1 + IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAAD(templateAad(beneficiaryId, consentId));
    decipher.setAuthTag(tag);
    const decoded = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    return validateEmbedding(JSON.parse(decoded));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, "INVALID_BIOMETRIC_TEMPLATE", "Stored biometric template cannot be decrypted.");
  }
}

function detectedImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export function assertValidBiometricCapture(file) {
  if (!file?.buffer?.length) {
    throw new AppError(400, "BIOMETRIC_CAPTURE_REQUIRED", "A faceCapture image file is required.");
  }
  if (file.buffer.length < 512) {
    throw new AppError(400, "BIOMETRIC_CAPTURE_TOO_SMALL", "The biometric capture is too small to process.");
  }
  const detectedType = detectedImageType(file.buffer);
  if (!detectedType) {
    throw new AppError(400, "INVALID_BIOMETRIC_CAPTURE_CONTENT", "The uploaded biometric capture content is not JPEG, PNG, or WebP.");
  }
  return detectedType;
}

function validateScore(value, name) {
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new AppError(502, "INVALID_BIOMETRIC_PROCESSOR_RESPONSE", `${name} must be between 0 and 1.`);
  }
  return Math.round(score * 10_000) / 10_000;
}

function validateEmbedding(value) {
  if (!Array.isArray(value) || value.length < 32 || value.length > 4096) {
    throw new AppError(502, "INVALID_BIOMETRIC_PROCESSOR_RESPONSE", "Biometric embedding dimensions are invalid.");
  }
  return value.map((entry) => {
    const number = Number(entry);
    if (!Number.isFinite(number) || number < -1 || number > 1) {
      throw new AppError(502, "INVALID_BIOMETRIC_PROCESSOR_RESPONSE", "Biometric embedding contains an invalid value.");
    }
    return number;
  });
}

export function normalizeBiometricEmbedding(value) {
  if (!Array.isArray(value) || value.length < 32 || value.length > 4096) {
    throw new AppError(502, "INVALID_BIOMETRIC_PROCESSOR_RESPONSE", "Biometric embedding dimensions are invalid.");
  }
  const numbers = value.map((entry) => Number(entry));
  if (numbers.some((entry) => !Number.isFinite(entry))) {
    throw new AppError(502, "INVALID_BIOMETRIC_PROCESSOR_RESPONSE", "Biometric embedding contains an invalid value.");
  }
  const magnitude = Math.sqrt(numbers.reduce((sum, entry) => sum + entry ** 2, 0));
  if (!magnitude) {
    throw new AppError(502, "INVALID_BIOMETRIC_PROCESSOR_RESPONSE", "Biometric embedding has zero magnitude.");
  }
  return validateEmbedding(numbers.map((entry) => entry / magnitude));
}

export function parseDeepFaceRepresentation(body) {
  if (!Array.isArray(body?.results)) {
    throw new AppError(502, "INVALID_BIOMETRIC_PROCESSOR_RESPONSE", "The biometric processor returned an invalid result.");
  }
  if (body.results.length !== 1) {
    throw new AppError(422, "BIOMETRIC_FACE_COUNT_INVALID", "Show exactly one unobstructed face to the camera.");
  }
  return normalizeBiometricEmbedding(body.results[0]?.embedding);
}

function simulatedEmbedding(buffer) {
  const values = [];
  for (let counter = 0; values.length < 128; counter += 1) {
    const digest = createHash("sha512").update(buffer).update(String(counter)).digest();
    for (const byte of digest) values.push((byte - 127.5) / 127.5);
  }
  const embedding = values.slice(0, 128);
  const magnitude = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
  return embedding.map((value) => value / magnitude);
}

function simulatedLiveness(buffer) {
  const sampled = buffer.subarray(0, Math.min(buffer.length, 65_536));
  const uniqueBytes = new Set(sampled).size;
  return Math.min(0.99, Math.max(0.05, uniqueBytes / 220));
}

export function cosineSimilarity(left, right) {
  if (left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return Math.max(0, Math.min(1, dot / Math.sqrt(leftMagnitude * rightMagnitude)));
}

export function duplicateScanWhere(beneficiaryId, model, now = new Date()) {
  return {
    beneficiaryId: { not: beneficiaryId },
    insightfaceModel: model,
    dataStatus: "ACTIVE",
    beneficiary: { status: "ACTIVE" },
    consent: {
      consentGiven: true,
      revokedAt: null,
      retentionUntil: { gt: now },
    },
  };
}

export function findBiometricDuplicateMatch(embedding, profiles, threshold = env.biometricMatchThreshold) {
  let bestMatch = null;
  for (const profile of profiles) {
    const reference = decryptBiometricTemplate(
      profile.faceEmbedding,
      profile.beneficiaryId,
      profile.consentId,
    );
    let matchScore;
    try {
      matchScore = validateScore(cosineSimilarity(embedding, reference), "matchScore");
    } finally {
      reference.fill(0);
    }
    if (matchScore >= threshold && (!bestMatch || matchScore > bestMatch.matchScore)) {
      bestMatch = { profile, matchScore };
    }
  }
  return bestMatch;
}

export async function acquireBiometricEnrollmentLock(database) {
  // ponytail: one cross-instance lock keeps scan-and-write exact; use pgvector/ANN partition locks
  // only when measured enrollment throughput makes the serialized O(n) scan a bottleneck.
  await database.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('garantiyaid-biometric-enrollment'))`;
}

async function remoteRepresentation(file) {
  if (!env.biometricServiceUrl) {
    throw new AppError(503, "BIOMETRIC_SERVICE_UNAVAILABLE", "Remote biometric service URL is not configured.");
  }
  const form = new FormData();
  form.append("img", new Blob([file.buffer], { type: file.detectedType }), "capture.jpg");
  form.append("model_name", DEEPFACE_MODEL);
  form.append("detector_backend", "opencv");
  form.append("enforce_detection", "true");
  form.append("align", "true");
  form.append("anti_spoofing", "true");
  form.append("max_faces", "2");
  try {
    const response = await fetch(`${env.biometricServiceUrl.replace(/\/$/, "")}/represent`, {
      method: "POST",
      headers: env.biometricServiceApiKey
        ? { authorization: `Bearer ${env.biometricServiceApiKey}` }
        : {},
      body: form,
      signal: AbortSignal.timeout(env.biometricRequestTimeoutMs),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const processorMessage = String(body?.error ?? body?.detail ?? "");
      if (/spoof/i.test(processorMessage)) return null;
      if (response.status >= 400 && response.status < 500) {
        throw new AppError(422, "BIOMETRIC_CAPTURE_REJECTED", "No clear live face was detected. Center one person in even lighting and try again.");
      }
      throw new AppError(503, "BIOMETRIC_SERVICE_UNAVAILABLE", "The biometric processor rejected or could not process the capture.");
    }
    return parseDeepFaceRepresentation(body);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, "BIOMETRIC_SERVICE_UNAVAILABLE", "The biometric processor is unavailable.");
  }
}

export async function processBiometricEnrollment(file) {
  const detectedType = assertValidBiometricCapture(file);
  if (env.biometricProcessorMode === "SIMULATED") {
    const livenessScore = simulatedLiveness(file.buffer);
    return {
      embedding: simulatedEmbedding(file.buffer),
      livenessScore,
      livenessPassed: livenessScore >= env.biometricLivenessThreshold,
      model: SIMULATED_MODEL,
      processor: "SIMULATED_LOCAL",
      simulated: true,
    };
  }
  const embedding = await remoteRepresentation({ ...file, detectedType });
  const livenessScore = embedding ? 1 : 0;
  return {
    embedding,
    livenessScore,
    livenessPassed: Boolean(embedding) && livenessScore >= env.biometricLivenessThreshold,
    model: DEEPFACE_MODEL,
    processor: DEEPFACE_PROCESSOR,
    simulated: false,
  };
}

export async function processBiometricVerification(file, referenceEmbedding) {
  const detectedType = assertValidBiometricCapture(file);
  if (env.biometricProcessorMode === "SIMULATED") {
    const livenessScore = simulatedLiveness(file.buffer);
    const matchScore = cosineSimilarity(simulatedEmbedding(file.buffer), referenceEmbedding);
    return {
      livenessScore,
      livenessPassed: livenessScore >= env.biometricLivenessThreshold,
      matchScore,
      matchPassed: matchScore >= env.biometricMatchThreshold,
      processor: "SIMULATED_LOCAL",
      simulated: true,
    };
  }
  const embedding = await remoteRepresentation({ ...file, detectedType });
  const livenessScore = embedding ? 1 : 0;
  const matchScore = embedding ? validateScore(cosineSimilarity(embedding, referenceEmbedding), "matchScore") : 0;
  return {
    livenessScore,
    livenessPassed: Boolean(embedding) && livenessScore >= env.biometricLivenessThreshold,
    matchScore,
    matchPassed: Boolean(embedding) && matchScore >= env.biometricMatchThreshold,
    processor: DEEPFACE_PROCESSOR,
    simulated: false,
  };
}

export const biometricProcessingDisclosure = Object.freeze({
  rawCaptureStored: false,
  templateReturned: false,
  processorMode: env.biometricProcessorMode,
  simulatedProcessor: env.biometricProcessorMode === "SIMULATED",
  model: env.biometricProcessorMode === "REMOTE" ? DEEPFACE_MODEL : SIMULATED_MODEL,
  antiSpoofingEnabled: env.biometricProcessorMode === "REMOTE",
});
