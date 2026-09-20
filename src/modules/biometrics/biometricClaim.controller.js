import { createHash } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import {
  publishBiometricVerificationResult,
  publishClaimSignatureResult,
} from "../../realtime/publishers.js";
import { idempotencyKeySchema } from "../distributions/distributionAllocation.schemas.js";
import {
  assertDistributionOpenForClaims,
  claimMutationSelect,
  claimMutationToResponse,
  getDistributionClaimParentOrThrow,
} from "../distributions/distributionClaim.service.js";
import { assertDistributionReadAllowed } from "../distributions/distribution.policy.js";
import { assertBiometricVerifyAllowed } from "./biometric.policy.js";
import {
  assertValidBiometricCapture,
  biometricAttemptPublicSelect,
  biometricAttemptToResponse,
  biometricProcessingDisclosure,
  biometricProfileInternalSelect,
  biometricProfileStatus,
  decryptBiometricTemplate,
  processBiometricVerification,
} from "./biometric.service.js";
import {
  encryptSignatureImage,
  parseSignatureDataUrl,
  signatureEvidenceToResponse,
  signatureImageHash,
} from "./claimSignature.service.js";

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function idempotencyKey(req) {
  const rawKey = req.get("idempotency-key");
  if (!rawKey) {
    throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "An Idempotency-Key UUID header is required for biometric claim verification.");
  }
  const parsed = idempotencyKeySchema.safeParse(rawKey.trim());
  if (!parsed.success) {
    throw new AppError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be a valid UUID.");
  }
  return parsed.data;
}

function signatureIdempotencyKey(req) {
  const rawKey = req.get("idempotency-key");
  if (!rawKey) {
    throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "An Idempotency-Key UUID header is required for signature submission.");
  }
  const parsed = idempotencyKeySchema.safeParse(rawKey.trim());
  if (!parsed.success) {
    throw new AppError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be a valid UUID.");
  }
  return parsed.data;
}

function requestHash(file, beneficiaryId, deviceInfo) {
  return createHash("sha256").update(JSON.stringify({
    captureHash: createHash("sha256").update(file.buffer).digest("hex"),
    beneficiaryId,
    deviceInfo: deviceInfo ?? null,
  })).digest("hex");
}

function assertMatchingRequest(record, hash) {
  if (record.requestHash !== hash) {
    throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used with a different biometric verification request.");
  }
}

function assertMatchingSignatureRequest(record, hash) {
  if (record.requestHash !== hash) {
    throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used with different signature evidence.");
  }
}

function failureBody(req, code, message, details) {
  return {
    success: false,
    error: { code, message, requestId: req.requestId, ...(details ? { details } : {}) },
  };
}

async function sendBiometricResult(res, distributionId, beneficiaryId, result) {
  res.set("Idempotency-Replayed", String(result.replayed));
  await publishBiometricVerificationResult(distributionId, beneficiaryId, result);
  return res.status(result.responseStatus).json(result.responseBody);
}

async function runBiometricClaimTransaction(operation) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
    } catch (error) {
      lastError = error;
      if (!['P2034', 'P2002'].includes(error.code) || attempt === 3) break;
    }
  }
  if (["P2034", "P2002"].includes(lastError?.code)) {
    throw new AppError(409, "BIOMETRIC_CLAIM_CONCURRENT_CHANGE", "Biometric claim data changed concurrently. Refresh and try again.");
  }
  throw lastError;
}

async function findReplay(identity) {
  const record = await prisma.idempotencyRecord.findUnique({
    where: { userId_operation_idempotencyKey: identity },
  });
  if (!record) return null;
  if (record.expiresAt > new Date()) return record;
  await prisma.idempotencyRecord.deleteMany({
    where: { idempotencyRecordId: record.idempotencyRecordId, expiresAt: { lte: new Date() } },
  });
  return null;
}

async function saveAttempt(tx, req, {
  distributionId,
  beneficiaryId,
  biometricId = null,
  claimId = null,
  result,
  matchScore = null,
  livenessScore = null,
  deviceInfo,
  processor,
}) {
  const attempt = await tx.biometricVerificationAttempt.create({
    data: {
      distributionId,
      beneficiaryId,
      biometricId,
      claimId,
      verifiedById: req.auth.userId,
      result,
      matchScore,
      livenessScore,
      deviceInfo,
      processor,
    },
    select: { attemptId: true },
  });
  await tx.auditLog.create({
    data: {
      userId: req.auth.userId,
      action: result === "MATCHED" ? "BIOMETRIC_CLAIM_MATCHED" : "BIOMETRIC_CLAIM_REJECTED",
      entityAffected: "BIOMETRIC_VERIFICATION_ATTEMPT",
      recordId: attempt.attemptId,
      ipAddress: clientIpAddress(req),
      details: {
        distributionId,
        beneficiaryId,
        result,
        ...(claimId ? { claimId } : {}),
        processor,
        rawCaptureStored: false,
      },
    },
  });
  return attempt.attemptId;
}

function idempotencyData(identity, hash, responseStatus, responseBody, now = new Date()) {
  return {
    ...identity,
    requestHash: hash,
    responseStatus,
    responseBody,
    expiresAt: new Date(now.getTime() + env.idempotencyTtlHours * 60 * 60 * 1000),
  };
}

async function persistRejectedRequest(req, {
  identity,
  hash,
  distributionId,
  beneficiaryId,
  biometricId,
  claimId,
  result,
  status,
  code,
  message,
  deviceInfo,
  processor,
  matchScore = null,
  livenessScore = null,
}) {
  return runBiometricClaimTransaction(async (tx) => {
    const concurrent = await tx.idempotencyRecord.findUnique({
      where: { userId_operation_idempotencyKey: identity },
    });
    if (concurrent && concurrent.expiresAt > new Date()) {
      assertMatchingRequest(concurrent, hash);
      return { replayed: true, responseStatus: concurrent.responseStatus, responseBody: concurrent.responseBody };
    }
    const attemptId = await saveAttempt(tx, req, {
      distributionId,
      beneficiaryId,
      biometricId,
      claimId,
      result,
      matchScore,
      livenessScore,
      deviceInfo,
      processor,
    });
    const responseBody = jsonSafe(failureBody(req, code, message, { attemptId }));
    await tx.idempotencyRecord.create({
      data: idempotencyData(identity, hash, status, responseBody),
    });
    return { replayed: false, responseStatus: status, responseBody };
  });
}

function assertSignatureClaimReady(claim, distributionId) {
  if (!claim || claim.distributionId !== distributionId) {
    throw new AppError(404, "SIGNATURE_CLAIM_NOT_FOUND", "The pending claim was not found for this distribution event.");
  }
  if (claim.signatureVerified || claim.signature) {
    throw new AppError(409, "SIGNATURE_ALREADY_RECORDED", "A protected signature is already recorded for this claim.");
  }
  if (
    claim.claimStatus !== "PENDING"
    || claim.verificationMethod !== "BIOMETRIC_AND_SIGNATURE"
    || !claim.biometricVerified
  ) {
    throw new AppError(409, "CLAIM_NOT_READY_FOR_SIGNATURE", "Complete a successful face verification before collecting the beneficiary signature.");
  }
}

function assertTypedSignatureName(claim, signatureMethod, typedName) {
  if (signatureMethod !== "TYPED") return;
  const normalize = (value) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-PH");
  const expectedName = [claim.beneficiary.firstName, claim.beneficiary.middleName, claim.beneficiary.lastName]
    .filter(Boolean)
    .join(" ");
  if (normalize(typedName) !== normalize(expectedName)) {
    throw new AppError(400, "SIGNATURE_NAME_MISMATCH", "The typed signature must match the beneficiary's full legal name.");
  }
}

export const verifyBiometricClaim = asyncHandler(async (req, res) => {
  assertBiometricVerifyAllowed(req.staffUser);
  assertValidBiometricCapture(req.file);
  const { distributionId } = req.validatedParams;
  const { beneficiaryId, deviceInfo } = req.validatedBody;
  const key = idempotencyKey(req);
  const hash = requestHash(req.file, beneficiaryId, deviceInfo);
  const identity = {
    userId: req.auth.userId,
    operation: `BIOMETRIC_CLAIM_VERIFY:${distributionId}`,
    idempotencyKey: key,
  };
  await prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  const replay = await findReplay(identity);
  if (replay) {
    assertMatchingRequest(replay, hash);
    req.file.buffer.fill(0);
    res.set("Idempotency-Replayed", "true");
    return res.status(replay.responseStatus).json(replay.responseBody);
  }

  const distribution = await getDistributionClaimParentOrThrow(distributionId, req.staffUser);
  assertDistributionOpenForClaims(distribution);
  if (distribution.verificationRequirement === "QR") {
    req.file.buffer.fill(0);
    throw new AppError(409, "BIOMETRIC_NOT_REQUIRED", "This distribution event is configured for QR verification only.");
  }
  const [schedule, allocation, profile] = await Promise.all([
    prisma.schedule.findUnique({
      where: { distributionId_beneficiaryId: { distributionId, beneficiaryId } },
      select: { scheduleId: true, status: true },
    }),
    prisma.distributionAllocation.findUnique({
      where: { distributionId_beneficiaryId: { distributionId, beneficiaryId } },
      select: { allocationId: true, allocationStatus: true },
    }),
    prisma.biometricData.findUnique({
      where: { beneficiaryId },
      select: biometricProfileInternalSelect,
    }),
  ]);
  if (!schedule || !allocation) {
    req.file.buffer.fill(0);
    throw new AppError(404, "BIOMETRIC_CLAIM_CANDIDATE_NOT_FOUND", "No scheduled allocation exists for this beneficiary and distribution event.");
  }
  if (!profile) {
    req.file.buffer.fill(0);
    const result = await persistRejectedRequest(req, {
      identity, hash, distributionId, beneficiaryId, result: "PROFILE_UNAVAILABLE",
      status: 409, code: "BIOMETRIC_PROFILE_REQUIRED",
      message: "The beneficiary does not have an enrolled biometric profile.",
      deviceInfo, processor: "NOT_RUN",
    });
    return sendBiometricResult(res, distributionId, beneficiaryId, result);
  }
  const profileStatus = biometricProfileStatus(profile);
  if (profileStatus !== "ENROLLED") {
    req.file.buffer.fill(0);
    const duplicateReviewRequired = ["PENDING_DUPLICATE_REVIEW", "DUPLICATE_BLOCKED"].includes(profileStatus);
    const result = await persistRejectedRequest(req, {
      identity, hash, distributionId, beneficiaryId, biometricId: profile.biometricId,
      result: duplicateReviewRequired ? "DUPLICATE" : "CONSENT_INVALID",
      status: 409,
      code: duplicateReviewRequired
        ? "BIOMETRIC_DUPLICATE_REVIEW_REQUIRED"
        : "BIOMETRIC_CONSENT_INVALID",
      message: duplicateReviewRequired
        ? "Biometric verification is blocked until authorized staff resolve the possible duplicate profile."
        : "Biometric verification is blocked because consent is revoked, declined, or expired.",
      deviceInfo, processor: "NOT_RUN",
    });
    return sendBiometricResult(res, distributionId, beneficiaryId, result);
  }

  const reference = decryptBiometricTemplate(profile.faceEmbedding, beneficiaryId, profile.consentId);
  let processing;
  try {
    processing = await processBiometricVerification(req.file, reference);
  } catch (error) {
    req.file.buffer.fill(0);
    if (error.code !== "BIOMETRIC_SERVICE_UNAVAILABLE") throw error;
    const result = await persistRejectedRequest(req, {
      identity, hash, distributionId, beneficiaryId, biometricId: profile.biometricId,
      result: "PROCESSOR_ERROR", status: 503, code: error.code, message: error.message,
      deviceInfo, processor: "REMOTE_DEEPFACE_ARCFACE",
    });
    return sendBiometricResult(res, distributionId, beneficiaryId, result);
  } finally {
    req.file?.buffer?.fill(0);
  }
  if (!processing.livenessPassed) {
    const result = await persistRejectedRequest(req, {
      identity, hash, distributionId, beneficiaryId, biometricId: profile.biometricId,
      result: "LIVENESS_FAILED", status: 422, code: "BIOMETRIC_LIVENESS_FAILED",
      message: "The biometric capture failed liveness verification.", deviceInfo,
      processor: processing.processor, matchScore: processing.matchScore,
      livenessScore: processing.livenessScore,
    });
    return sendBiometricResult(res, distributionId, beneficiaryId, result);
  }
  if (!processing.matchPassed) {
    const result = await persistRejectedRequest(req, {
      identity, hash, distributionId, beneficiaryId, biometricId: profile.biometricId,
      result: "NO_MATCH", status: 422, code: "BIOMETRIC_NO_MATCH",
      message: "The biometric capture does not match the enrolled beneficiary.", deviceInfo,
      processor: processing.processor, matchScore: processing.matchScore,
      livenessScore: processing.livenessScore,
    });
    return sendBiometricResult(res, distributionId, beneficiaryId, result);
  }

  const result = await runBiometricClaimTransaction(async (tx) => {
    const concurrent = await tx.idempotencyRecord.findUnique({
      where: { userId_operation_idempotencyKey: identity },
    });
    if (concurrent && concurrent.expiresAt > new Date()) {
      assertMatchingRequest(concurrent, hash);
      return { replayed: true, responseStatus: concurrent.responseStatus, responseBody: concurrent.responseBody };
    }
    const currentDistribution = await getDistributionClaimParentOrThrow(distributionId, req.staffUser, tx);
    assertDistributionOpenForClaims(currentDistribution);
    if (currentDistribution.verificationRequirement === "QR") {
      throw new AppError(409, "BIOMETRIC_NOT_REQUIRED", "This distribution event is configured for QR verification only.");
    }
    const currentProfile = await tx.biometricData.findUnique({
      where: { beneficiaryId },
      select: biometricProfileInternalSelect,
    });
    if (!currentProfile || currentProfile.biometricId !== profile.biometricId || biometricProfileStatus(currentProfile) !== "ENROLLED") {
      throw new AppError(409, "BIOMETRIC_PROFILE_CHANGED", "Biometric profile or consent changed during verification.");
    }
    const currentSchedule = await tx.schedule.findUnique({
      where: { distributionId_beneficiaryId: { distributionId, beneficiaryId } },
      select: { scheduleId: true, status: true },
    });
    const currentAllocation = await tx.distributionAllocation.findUnique({
      where: { distributionId_beneficiaryId: { distributionId, beneficiaryId } },
      select: { allocationId: true, allocationStatus: true },
    });
    const existingClaim = await tx.claim.findUnique({
      where: { beneficiaryId_distributionId: { beneficiaryId, distributionId } },
      select: claimMutationSelect,
    });
    let claim;
    let completedVerification;
    if (existingClaim) {
      if (
        currentDistribution.verificationRequirement === "QR_AND_BIOMETRIC"
        && existingClaim.claimStatus === "PENDING"
        && existingClaim.qrVerified
        && !existingClaim.biometricVerified
      ) {
        claim = await tx.claim.update({
          where: { claimId: existingClaim.claimId },
          data: {
            claimStatus: "VERIFIED",
            verificationMethod: "QR_AND_BIOMETRIC",
            biometricVerified: true,
            biometricScore: processing.matchScore,
            verifiedById: req.auth.userId,
          },
          select: claimMutationSelect,
        });
        completedVerification = true;
      } else {
        const attemptId = await saveAttempt(tx, req, {
          distributionId, beneficiaryId, biometricId: profile.biometricId,
          claimId: existingClaim.claimId, result: "DUPLICATE",
          matchScore: processing.matchScore, livenessScore: processing.livenessScore,
          deviceInfo, processor: processing.processor,
        });
        const responseBody = jsonSafe(failureBody(req, "DUPLICATE_CLAIM", "A claim already exists for this beneficiary and distribution event.", { attemptId, claimId: existingClaim.claimId }));
        await tx.idempotencyRecord.create({ data: idempotencyData(identity, hash, 409, responseBody) });
        return { replayed: false, responseStatus: 409, responseBody };
      }
    } else {
      if (currentSchedule?.status !== "SCHEDULED") {
        throw new AppError(409, "SCHEDULE_NOT_CLAIMABLE", "The beneficiary does not have an active claimable schedule.");
      }
      if (currentAllocation?.allocationStatus !== "ALLOCATED") {
        throw new AppError(409, "ALLOCATION_NOT_CLAIMABLE", "The beneficiary does not have an active claimable allocation.");
      }
      completedVerification = currentDistribution.verificationRequirement === "BIOMETRIC";
      claim = await tx.claim.create({
        data: {
          beneficiaryId,
          distributionId,
          scheduleId: currentSchedule.scheduleId,
          verifiedById: req.auth.userId,
          allocationId: currentAllocation.allocationId,
          claimStatus: completedVerification ? "VERIFIED" : "PENDING",
          verificationMethod: currentDistribution.verificationRequirement,
          biometricVerified: true,
          biometricScore: processing.matchScore,
          qrVerified: false,
          isDuplicateFlag: false,
        },
        select: claimMutationSelect,
      });
      const scheduleUpdate = await tx.schedule.updateMany({
        where: { scheduleId: currentSchedule.scheduleId, status: "SCHEDULED" },
        data: { status: "CHECKED_IN" },
      });
      if (scheduleUpdate.count !== 1) {
        throw new AppError(409, "BIOMETRIC_CLAIM_CONCURRENT_CHANGE", "Schedule changed during biometric verification.");
      }
    }
    const attemptId = await saveAttempt(tx, req, {
      distributionId, beneficiaryId, biometricId: profile.biometricId,
      claimId: claim.claimId, result: "MATCHED", matchScore: processing.matchScore,
      livenessScore: processing.livenessScore, deviceInfo, processor: processing.processor,
    });
    await tx.biometricData.update({
      where: { biometricId: profile.biometricId },
      data: { verificationCount: { increment: 1 }, lastVerifiedAt: new Date() },
    });
    const nextRequiredVerification = completedVerification
      ? null
      : currentDistribution.verificationRequirement === "BIOMETRIC_AND_SIGNATURE" ? "SIGNATURE" : "QR";
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: completedVerification
          ? "CLAIM_VERIFIED_BY_BIOMETRIC"
          : nextRequiredVerification === "SIGNATURE" ? "CLAIM_AWAITING_SIGNATURE" : "CLAIM_AWAITING_QR",
        entityAffected: "CLAIM",
        recordId: claim.claimId,
        ipAddress: clientIpAddress(req),
        details: {
          distributionId, beneficiaryId, attemptId,
          verificationRequirement: currentDistribution.verificationRequirement,
          claimStatus: claim.claimStatus,
          rawCaptureStored: false,
          walletTransactionCreated: false,
        },
      },
    });
    const responseBody = jsonSafe({
      success: true,
      data: {
        claim: claimMutationToResponse(claim),
        biometricVerification: {
          attemptId,
          livenessPassed: true,
          matchPassed: true,
          matchScore: processing.matchScore.toFixed(4),
          processor: processing.processor,
          ...biometricProcessingDisclosure,
        },
        verificationComplete: completedVerification,
        nextRequiredVerification,
        walletTransactionCreated: false,
      },
    });
    await tx.idempotencyRecord.create({ data: idempotencyData(identity, hash, 201, responseBody) });
    return { replayed: false, responseStatus: 201, responseBody };
  });
  return sendBiometricResult(res, distributionId, beneficiaryId, result);
});

export const submitClaimSignature = asyncHandler(async (req, res) => {
  assertBiometricVerifyAllowed(req.staffUser);
  const { distributionId, claimId } = req.validatedParams;
  const { signatureDataUrl, signatureMethod, pointCount, typedName, deviceInfo } = req.validatedBody;
  const image = parseSignatureDataUrl(signatureDataUrl);
  const clearImage = () => image.fill(0);
  res.once("finish", clearImage);
  res.once("close", clearImage);
  const imageSha256 = signatureImageHash(image);
  const key = signatureIdempotencyKey(req);
  const hash = createHash("sha256").update(JSON.stringify({ claimId, imageSha256, signatureMethod, pointCount: pointCount ?? null, typedName: typedName ?? null, deviceInfo: deviceInfo ?? null })).digest("hex");
  const identity = {
    userId: req.auth.userId,
    operation: `CLAIM_SIGNATURE:${distributionId}:${claimId}`,
    idempotencyKey: key,
  };
  await prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  const replay = await findReplay(identity);
  if (replay) {
    assertMatchingSignatureRequest(replay, hash);
    image.fill(0);
    res.set("Idempotency-Replayed", "true");
    return res.status(replay.responseStatus).json(replay.responseBody);
  }

  const distribution = await getDistributionClaimParentOrThrow(distributionId, req.staffUser);
  assertDistributionOpenForClaims(distribution);
  if (distribution.verificationRequirement !== "BIOMETRIC_AND_SIGNATURE") {
    image.fill(0);
    throw new AppError(409, "SIGNATURE_NOT_REQUIRED", "This distribution event is not configured for Face + Signature verification.");
  }
  const pendingClaim = await prisma.claim.findUnique({
    where: { claimId },
    select: {
      claimId: true,
      beneficiaryId: true,
      distributionId: true,
      claimStatus: true,
      verificationMethod: true,
      biometricVerified: true,
      signatureVerified: true,
      beneficiary: { select: { firstName: true, middleName: true, lastName: true } },
      signature: { select: { signatureId: true } },
    },
  });
  assertSignatureClaimReady(pendingClaim, distributionId);
  assertTypedSignatureName(pendingClaim, signatureMethod, typedName);
  const encryptedImage = encryptSignatureImage(image, claimId, pendingClaim.beneficiaryId, distributionId);
  image.fill(0);

  const result = await runBiometricClaimTransaction(async (tx) => {
    const concurrent = await tx.idempotencyRecord.findUnique({
      where: { userId_operation_idempotencyKey: identity },
    });
    if (concurrent && concurrent.expiresAt > new Date()) {
      assertMatchingSignatureRequest(concurrent, hash);
      return { replayed: true, responseStatus: concurrent.responseStatus, responseBody: concurrent.responseBody };
    }
    const currentDistribution = await getDistributionClaimParentOrThrow(distributionId, req.staffUser, tx);
    assertDistributionOpenForClaims(currentDistribution);
    if (currentDistribution.verificationRequirement !== "BIOMETRIC_AND_SIGNATURE") {
      throw new AppError(409, "SIGNATURE_NOT_REQUIRED", "This distribution event is not configured for Face + Signature verification.");
    }
    const currentClaim = await tx.claim.findUnique({
      where: { claimId },
      select: {
        claimId: true,
        beneficiaryId: true,
        distributionId: true,
        claimStatus: true,
        verificationMethod: true,
        biometricVerified: true,
        signatureVerified: true,
        beneficiary: { select: { firstName: true, middleName: true, lastName: true } },
        signature: { select: { signatureId: true } },
      },
    });
    assertSignatureClaimReady(currentClaim, distributionId);
    assertTypedSignatureName(currentClaim, signatureMethod, typedName);
    const signature = await tx.claimSignature.create({
      data: {
        claimId,
        capturedById: req.auth.userId,
        encryptedImage,
        imageSha256,
        signatureMethod,
        pointCount: pointCount ?? null,
        deviceInfo,
      },
      select: {
        signatureId: true,
        claimId: true,
        capturedById: true,
        imageSha256: true,
        signatureMethod: true,
        pointCount: true,
        signedAt: true,
      },
    });
    const claim = await tx.claim.update({
      where: { claimId },
      data: { claimStatus: "VERIFIED", signatureVerified: true, verifiedById: req.auth.userId },
      select: claimMutationSelect,
    });
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "CLAIM_VERIFIED_BY_BIOMETRIC_AND_SIGNATURE",
        entityAffected: "CLAIM",
        recordId: claimId,
        ipAddress: clientIpAddress(req),
        details: {
          distributionId,
          beneficiaryId: claim.beneficiaryId,
          signatureId: signature.signatureId,
          imageSha256,
          signatureMethod,
          pointCount: pointCount ?? null,
          typedNameMatched: signatureMethod === "TYPED",
          attestationConfirmed: true,
          encryptedAtRest: true,
          rawSignatureReturned: false,
          walletTransactionCreated: false,
        },
      },
    });
    const responseBody = jsonSafe({
      success: true,
      data: {
        claim: claimMutationToResponse(claim),
        signature: signatureEvidenceToResponse(signature),
        verificationComplete: true,
        nextRequiredVerification: null,
        walletTransactionCreated: false,
      },
    });
    await tx.idempotencyRecord.create({ data: idempotencyData(identity, hash, 201, responseBody) });
    return { replayed: false, responseStatus: 201, responseBody };
  });
  res.set("Idempotency-Replayed", String(result.replayed));
  await publishClaimSignatureResult(distributionId, result);
  return res.status(result.responseStatus).json(result.responseBody);
});

export const listBiometricAttempts = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { page, pageSize, result, beneficiaryId, claimId } = req.validatedQuery;
  await getDistributionClaimParentOrThrow(distributionId, req.staffUser);
  const where = {
    distributionId,
    ...(result ? { result } : {}),
    ...(beneficiaryId ? { beneficiaryId } : {}),
    ...(claimId ? { claimId } : {}),
  };
  const [attempts, total] = await Promise.all([
    prisma.biometricVerificationAttempt.findMany({
      where,
      select: biometricAttemptPublicSelect,
      orderBy: [{ createdAt: "desc" }, { attemptId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.biometricVerificationAttempt.count({ where }),
  ]);
  return res.status(200).json({
    success: true,
    data: {
      attempts: attempts.map(biometricAttemptToResponse),
      summary: { matchingAttemptCount: total },
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      privacy: { rawCapturesStored: false, templatesReturned: false },
    },
  });
});
