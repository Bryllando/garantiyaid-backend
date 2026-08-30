import { createHash, randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { publishQrVerificationResult } from "../../realtime/publishers.js";
import { idempotencyKeySchema } from "./distributionAllocation.schemas.js";
import {
  assertClaimVerifyAllowed,
  assertDistributionReadAllowed,
  assertQrTokenManageAllowed,
} from "./distribution.policy.js";
import {
  assertDistributionOpenForClaims,
  assertQrVerificationConfigured,
  assertQrTokenReissuable,
  assertQrTokenRevocable,
  buildClaimSearchWhere,
  buildQrSearchWhere,
  buildQrStatusWhere,
  claimMutationSelect,
  claimMutationToResponse,
  claimPublicSelect,
  claimToResponse,
  distributionQrExpiry,
  effectiveQrStatus,
  generateRawQrToken,
  getClaimOrThrow,
  getDistributionClaimParentOrThrow,
  getQrTokenOrThrow,
  hashQrToken,
  qrEligibleScheduleSelect,
  qrEligibleScheduleToResponse,
  qrScanLogPublicSelect,
  qrTokenPublicSelect,
  qrTokenToResponse,
} from "./distributionClaim.service.js";

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

async function runQrTransaction(operation) {
  try {
    return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error.code === "P2034") {
      throw new AppError(
        409,
        "QR_CLAIM_CONCURRENT_CHANGE",
        "QR or claim data changed concurrently. Refresh and try again.",
      );
    }
    throw error;
  }
}

async function runClaimTransaction(operation) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
    } catch (error) {
      lastError = error;
      if (!["P2034", "P2002"].includes(error.code) || attempt === 3) {
        break;
      }
    }
  }
  if (["P2034", "P2002"].includes(lastError?.code)) {
    throw new AppError(
      409,
      "QR_CLAIM_CONCURRENT_CHANGE",
      "The QR token was processed concurrently. Check the claim list before trying again.",
    );
  }
  throw lastError;
}

function claimIdempotencyKey(req) {
  const rawKey = req.get("idempotency-key");
  if (!rawKey) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "An Idempotency-Key UUID header is required for QR claim verification.",
    );
  }
  const result = idempotencyKeySchema.safeParse(rawKey.trim());
  if (!result.success) {
    throw new AppError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be a valid UUID.");
  }
  return result.data;
}

function claimRequestHash(tokenHash, deviceInfo) {
  return createHash("sha256")
    .update(JSON.stringify({ tokenHash, deviceInfo: deviceInfo ?? null }))
    .digest("hex");
}

function assertMatchingIdempotencyRequest(record, requestHash) {
  if (record.requestHash !== requestHash) {
    throw new AppError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used with a different QR verification request.",
    );
  }
}

async function findUsableIdempotencyRecord(identity) {
  const record = await prisma.idempotencyRecord.findUnique({
    where: { userId_operation_idempotencyKey: identity },
  });
  if (!record) {
    return null;
  }
  if (record.expiresAt > new Date()) {
    return record;
  }
  await prisma.idempotencyRecord.deleteMany({
    where: {
      idempotencyRecordId: record.idempotencyRecordId,
      expiresAt: { lte: new Date() },
    },
  });
  return null;
}

function failureBody(req, code, message, details) {
  return {
    success: false,
    error: {
      code,
      message,
      requestId: req.requestId,
      ...(details ? { details } : {}),
    },
  };
}

async function createScanAttempt(tx, req, {
  distributionId,
  submittedTokenHash,
  qrTokenId = null,
  claimId = null,
  scanResult,
  deviceInfo,
}) {
  const scanLog = await tx.qrScanLog.create({
    data: {
      distributionId,
      qrTokenId,
      submittedTokenHash,
      claimId,
      scannedById: req.auth.userId,
      scanResult,
      deviceInfo,
    },
    select: { scanLogId: true },
  });
  await tx.auditLog.create({
    data: {
      userId: req.auth.userId,
      action: ["VERIFIED", "PENDING_BIOMETRIC"].includes(scanResult)
        ? "QR_CLAIM_VERIFIED"
        : "QR_SCAN_REJECTED",
      entityAffected: "QR_SCAN_LOG",
      recordId: scanLog.scanLogId,
      ipAddress: clientIpAddress(req),
      details: {
        distributionId,
        scanResult,
        ...(claimId ? { claimId } : {}),
      },
    },
  });
  return scanLog.scanLogId;
}

function qrCandidateWhere(distributionId, now = new Date()) {
  return {
    distributionId,
    status: "SCHEDULED",
    slot: { slotEnd: { gt: now } },
    claim: { is: null },
    beneficiary: {
      allocations: {
        some: { distributionId, allocationStatus: "ALLOCATED" },
      },
      qrTokens: { none: { distributionId } },
    },
  };
}

export const listQrEligibleSchedules = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { page, pageSize, search } = req.validatedQuery;
  const distribution = await getDistributionClaimParentOrThrow(distributionId, req.staffUser);
  assertDistributionOpenForClaims(distribution);
  assertQrVerificationConfigured(distribution);

  const nameSearch = search ? {
    OR: [
      { beneficiary: { firstName: { contains: search, mode: "insensitive" } } },
      { beneficiary: { middleName: { contains: search, mode: "insensitive" } } },
      { beneficiary: { lastName: { contains: search, mode: "insensitive" } } },
      ...(/^[0-9a-f-]{36}$/i.test(search) ? [
        { scheduleId: search },
        { beneficiaryId: search },
      ] : []),
    ],
  } : {};
  const where = { ...qrCandidateWhere(distributionId), ...nameSearch };
  const [schedules, total] = await Promise.all([
    prisma.schedule.findMany({
      where,
      select: qrEligibleScheduleSelect,
      orderBy: [{ slot: { slotStart: "asc" } }, { queueNumber: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.schedule.count({ where }),
  ]);
  return res.status(200).json({
    success: true,
    data: {
      schedules: schedules.map(qrEligibleScheduleToResponse),
      summary: { qrEligibleScheduleCount: total },
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
  });
});

export const generateQrTokens = asyncHandler(async (req, res) => {
  assertQrTokenManageAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { scheduleIds } = req.validatedBody;

  let result;
  try {
    result = await runQrTransaction(async (tx) => {
      const distribution = await getDistributionClaimParentOrThrow(
        distributionId,
        req.staffUser,
        tx,
      );
      assertDistributionOpenForClaims(distribution);
      assertQrVerificationConfigured(distribution);
      const now = new Date();

      const where = {
        ...qrCandidateWhere(distributionId, now),
        ...(scheduleIds ? { scheduleId: { in: scheduleIds } } : {}),
      };
      const schedules = await tx.schedule.findMany({
        where,
        select: qrEligibleScheduleSelect,
        orderBy: [{ slot: { slotStart: "asc" } }, { queueNumber: "asc" }],
      });
      if (scheduleIds && schedules.length !== scheduleIds.length) {
        throw new AppError(
          409,
          "SCHEDULE_NOT_ELIGIBLE_FOR_QR",
          "Every requested schedule must be active, allocated, unclaimed, and without a QR token.",
        );
      }
      if (schedules.length === 0) {
        throw new AppError(
          409,
          "NO_QR_ELIGIBLE_SCHEDULES",
          "There are no schedules eligible for QR-token generation.",
        );
      }

      const rows = schedules.map((schedule) => {
        const rawToken = generateRawQrToken();
        return {
          qrTokenId: randomUUID(),
          beneficiaryId: schedule.beneficiaryId,
          distributionId,
          tokenHash: hashQrToken(rawToken),
          expiresAt: distributionQrExpiry(distribution, schedule.slot.slotEnd),
          rawToken,
        };
      });
      await tx.qrToken.createMany({
        data: rows.map(({ rawToken: ignoredRawToken, ...row }) => ({
          ...row,
          qrStatus: "ACTIVE",
        })),
      });
      await tx.auditLog.createMany({
        data: rows.map((row) => ({
          userId: req.auth.userId,
          action: "QR_TOKEN_GENERATED",
          entityAffected: "QR_TOKEN",
          recordId: row.qrTokenId,
          ipAddress: clientIpAddress(req),
          details: {
            distributionId,
            beneficiaryId: row.beneficiaryId,
            expiresAt: row.expiresAt.toISOString(),
          },
        })),
      });
      const created = await tx.qrToken.findMany({
        where: { qrTokenId: { in: rows.map((row) => row.qrTokenId) } },
        select: qrTokenPublicSelect,
        orderBy: { createdAt: "asc" },
      });
      const rawById = new Map(rows.map((row) => [row.qrTokenId, row.rawToken]));
      return created.map((qrToken) => ({
        ...qrTokenToResponse(qrToken),
        token: rawById.get(qrToken.qrTokenId),
      }));
    });
  } catch (error) {
    if (error.code === "P2002") {
      throw new AppError(
        409,
        "QR_TOKEN_ALREADY_EXISTS",
        "A QR token already exists for one of the selected beneficiaries.",
      );
    }
    throw error;
  }

  return res.status(201).json({
    success: true,
    data: {
      qrTokens: result,
      summary: {
        generatedTokenCount: result.length,
        rawTokensReturnedOnce: true,
      },
    },
  });
});

export const listQrTokens = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { page, pageSize, status, search } = req.validatedQuery;
  await getDistributionClaimParentOrThrow(distributionId, req.staffUser);
  const now = new Date();
  const where = {
    distributionId,
    ...buildQrStatusWhere(status, now),
    ...buildQrSearchWhere(search),
  };
  const [qrTokens, total] = await Promise.all([
    prisma.qrToken.findMany({
      where,
      select: qrTokenPublicSelect,
      orderBy: [{ createdAt: "desc" }, { qrTokenId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.qrToken.count({ where }),
  ]);
  return res.status(200).json({
    success: true,
    data: {
      qrTokens: qrTokens.map((qrToken) => qrTokenToResponse(qrToken, now)),
      summary: { matchingTokenCount: total },
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
  });
});

export const getQrToken = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId, qrTokenId } = req.validatedParams;
  await getDistributionClaimParentOrThrow(distributionId, req.staffUser);
  const qrToken = await getQrTokenOrThrow(distributionId, qrTokenId);
  return res.status(200).json({
    success: true,
    data: { qrToken: qrTokenToResponse(qrToken) },
  });
});

export const revokeQrToken = asyncHandler(async (req, res) => {
  assertQrTokenManageAllowed(req.staffUser);
  const { distributionId, qrTokenId } = req.validatedParams;
  await runQrTransaction(async (tx) => {
    const distribution = await getDistributionClaimParentOrThrow(
      distributionId,
      req.staffUser,
      tx,
    );
    assertDistributionOpenForClaims(distribution);
    assertQrVerificationConfigured(distribution);
    const qrToken = await getQrTokenOrThrow(distributionId, qrTokenId, tx);
    assertQrTokenRevocable(qrToken);
    const update = await tx.qrToken.updateMany({
      where: { distributionId, qrTokenId, qrStatus: "ACTIVE", expiresAt: { gt: new Date() } },
      data: { qrStatus: "REVOKED" },
    });
    if (update.count !== 1) {
      throw new AppError(409, "QR_CLAIM_CONCURRENT_CHANGE", "QR token changed concurrently.");
    }
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "QR_TOKEN_REVOKED",
        entityAffected: "QR_TOKEN",
        recordId: qrTokenId,
        ipAddress: clientIpAddress(req),
        details: { distributionId, beneficiaryId: qrToken.beneficiaryId },
      },
    });
  });
  const qrToken = await getQrTokenOrThrow(distributionId, qrTokenId);
  return res.status(200).json({
    success: true,
    data: { qrToken: qrTokenToResponse(qrToken) },
  });
});

export const reissueQrToken = asyncHandler(async (req, res) => {
  assertQrTokenManageAllowed(req.staffUser);
  const { distributionId, qrTokenId } = req.validatedParams;
  const result = await runQrTransaction(async (tx) => {
    const distribution = await getDistributionClaimParentOrThrow(
      distributionId,
      req.staffUser,
      tx,
    );
    assertDistributionOpenForClaims(distribution);
    assertQrVerificationConfigured(distribution);
    const qrToken = await getQrTokenOrThrow(distributionId, qrTokenId, tx);
    assertQrTokenReissuable(qrToken);
    const schedule = await tx.schedule.findUnique({
      where: {
        distributionId_beneficiaryId: {
          distributionId,
          beneficiaryId: qrToken.beneficiaryId,
        },
      },
      select: {
        scheduleId: true,
        status: true,
        slot: { select: { slotEnd: true } },
      },
    });
    const allocation = await tx.distributionAllocation.findUnique({
      where: {
        distributionId_beneficiaryId: {
          distributionId,
          beneficiaryId: qrToken.beneficiaryId,
        },
      },
      select: { allocationId: true, allocationStatus: true },
    });
    const claim = await tx.claim.findUnique({
      where: {
        beneficiaryId_distributionId: {
          beneficiaryId: qrToken.beneficiaryId,
          distributionId,
        },
      },
      select: { claimId: true },
    });
    if (
      schedule?.status !== "SCHEDULED"
      || allocation?.allocationStatus !== "ALLOCATED"
      || claim
    ) {
      throw new AppError(
        409,
        "QR_TOKEN_REISSUE_NOT_ELIGIBLE",
        "The beneficiary must have an active schedule, active allocation, and no claim.",
      );
    }
    const expiresAt = distributionQrExpiry(distribution, schedule.slot.slotEnd);
    if (expiresAt <= new Date()) {
      throw new AppError(
        409,
        "DISTRIBUTION_QR_EXPIRY_PASSED",
        "QR tokens cannot be reissued after the beneficiary's service session ends.",
      );
    }
    const rawToken = generateRawQrToken();
    const update = await tx.qrToken.updateMany({
      where: { distributionId, qrTokenId, qrStatus: qrToken.qrStatus },
      data: { tokenHash: hashQrToken(rawToken), qrStatus: "ACTIVE", expiresAt },
    });
    if (update.count !== 1) {
      throw new AppError(409, "QR_CLAIM_CONCURRENT_CHANGE", "QR token changed concurrently.");
    }
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "QR_TOKEN_REISSUED",
        entityAffected: "QR_TOKEN",
        recordId: qrTokenId,
        ipAddress: clientIpAddress(req),
        details: { distributionId, beneficiaryId: qrToken.beneficiaryId, expiresAt },
      },
    });
    return { rawToken };
  });
  const qrToken = await getQrTokenOrThrow(distributionId, qrTokenId);
  return res.status(200).json({
    success: true,
    data: {
      qrToken: { ...qrTokenToResponse(qrToken), token: result.rawToken },
      rawTokenReturnedOnce: true,
    },
  });
});

export const verifyQrClaim = asyncHandler(async (req, res) => {
  assertClaimVerifyAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { token, deviceInfo } = req.validatedBody;
  const submittedTokenHash = hashQrToken(token);
  const idempotencyKey = claimIdempotencyKey(req);
  const operation = `QR_CLAIM_VERIFY:${distributionId}`;
  const requestHash = claimRequestHash(submittedTokenHash, deviceInfo);
  const identity = { userId: req.auth.userId, operation, idempotencyKey };

  await prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  const existingRecord = await findUsableIdempotencyRecord(identity);
  if (existingRecord) {
    assertMatchingIdempotencyRequest(existingRecord, requestHash);
    res.set("Idempotency-Replayed", "true");
    return res.status(existingRecord.responseStatus).json(existingRecord.responseBody);
  }

  const result = await runClaimTransaction(async (tx) => {
    const transactionRecord = await tx.idempotencyRecord.findUnique({
      where: { userId_operation_idempotencyKey: identity },
    });
    if (transactionRecord && transactionRecord.expiresAt > new Date()) {
      assertMatchingIdempotencyRequest(transactionRecord, requestHash);
      return {
        replayed: true,
        responseStatus: transactionRecord.responseStatus,
        responseBody: transactionRecord.responseBody,
      };
    }

    const distribution = await getDistributionClaimParentOrThrow(
      distributionId,
      req.staffUser,
      tx,
    );
    assertDistributionOpenForClaims(distribution);
    assertQrVerificationConfigured(distribution);
    const now = new Date();
    const qrToken = await tx.qrToken.findFirst({
      where: { distributionId, tokenHash: submittedTokenHash },
      select: {
        qrTokenId: true,
        beneficiaryId: true,
        distributionId: true,
        qrStatus: true,
        expiresAt: true,
      },
    });

    let responseStatus;
    let responseBody;
    if (!qrToken) {
      const scanLogId = await createScanAttempt(tx, req, {
        distributionId,
        submittedTokenHash,
        scanResult: "INVALID_TOKEN",
        deviceInfo,
      });
      responseStatus = 404;
      responseBody = failureBody(
        req,
        "INVALID_QR_TOKEN",
        "The QR token is invalid for this distribution event.",
        { scanLogId },
      );
    } else if (qrToken.qrStatus === "USED") {
      const claim = await tx.claim.findUnique({
        where: {
          beneficiaryId_distributionId: {
            beneficiaryId: qrToken.beneficiaryId,
            distributionId,
          },
        },
        select: { claimId: true },
      });
      if (claim) {
        await tx.claim.update({
          where: { claimId: claim.claimId },
          data: { isDuplicateFlag: true },
        });
      }
      const scanLogId = await createScanAttempt(tx, req, {
        distributionId,
        submittedTokenHash,
        qrTokenId: qrToken.qrTokenId,
        claimId: claim?.claimId,
        scanResult: "DUPLICATE",
        deviceInfo,
      });
      responseStatus = 409;
      responseBody = failureBody(
        req,
        "QR_TOKEN_ALREADY_USED",
        "This QR token has already been used for claim verification.",
        { scanLogId, ...(claim ? { claimId: claim.claimId } : {}) },
      );
    } else if (qrToken.qrStatus === "REVOKED") {
      const scanLogId = await createScanAttempt(tx, req, {
        distributionId,
        submittedTokenHash,
        qrTokenId: qrToken.qrTokenId,
        scanResult: "REVOKED",
        deviceInfo,
      });
      responseStatus = 409;
      responseBody = failureBody(
        req,
        "QR_TOKEN_REVOKED",
        "This QR token has been revoked.",
        { scanLogId },
      );
    } else if (effectiveQrStatus(qrToken, now) === "EXPIRED") {
      await tx.qrToken.updateMany({
        where: { qrTokenId: qrToken.qrTokenId, qrStatus: "ACTIVE" },
        data: { qrStatus: "EXPIRED" },
      });
      const scanLogId = await createScanAttempt(tx, req, {
        distributionId,
        submittedTokenHash,
        qrTokenId: qrToken.qrTokenId,
        scanResult: "EXPIRED",
        deviceInfo,
      });
      responseStatus = 410;
      responseBody = failureBody(
        req,
        "QR_TOKEN_EXPIRED",
        "This QR token has expired.",
        { scanLogId },
      );
    } else {
      const schedule = await tx.schedule.findUnique({
        where: {
          distributionId_beneficiaryId: {
            distributionId,
            beneficiaryId: qrToken.beneficiaryId,
          },
        },
        select: { scheduleId: true, status: true },
      });
      const allocation = await tx.distributionAllocation.findUnique({
        where: {
          distributionId_beneficiaryId: {
            distributionId,
            beneficiaryId: qrToken.beneficiaryId,
          },
        },
        select: { allocationId: true, allocationStatus: true },
      });
      const existingClaim = await tx.claim.findUnique({
        where: {
          beneficiaryId_distributionId: {
            beneficiaryId: qrToken.beneficiaryId,
            distributionId,
          },
        },
        select: {
          ...claimMutationSelect,
        },
      });

      if (existingClaim) {
        if (
          distribution.verificationRequirement === "QR_AND_BIOMETRIC"
          && existingClaim.claimStatus === "PENDING"
          && existingClaim.biometricVerified
          && !existingClaim.qrVerified
        ) {
          const completedClaim = await tx.claim.update({
            where: { claimId: existingClaim.claimId },
            data: {
              claimStatus: "VERIFIED",
              verificationMethod: "QR_AND_BIOMETRIC",
              qrVerified: true,
              verifiedById: req.auth.userId,
            },
            select: claimMutationSelect,
          });
          const tokenUpdate = await tx.qrToken.updateMany({
            where: {
              qrTokenId: qrToken.qrTokenId,
              distributionId,
              qrStatus: "ACTIVE",
              expiresAt: { gt: now },
            },
            data: { qrStatus: "USED" },
          });
          if (tokenUpdate.count !== 1) {
            throw new AppError(
              409,
              "QR_CLAIM_CONCURRENT_CHANGE",
              "QR token changed during combined verification.",
            );
          }
          await createScanAttempt(tx, req, {
            distributionId,
            submittedTokenHash,
            qrTokenId: qrToken.qrTokenId,
            claimId: completedClaim.claimId,
            scanResult: "VERIFIED",
            deviceInfo,
          });
          await tx.auditLog.create({
            data: {
              userId: req.auth.userId,
              action: "CLAIM_VERIFIED_BY_QR_AND_BIOMETRIC",
              entityAffected: "CLAIM",
              recordId: completedClaim.claimId,
              ipAddress: clientIpAddress(req),
              details: {
                distributionId,
                beneficiaryId: qrToken.beneficiaryId,
                claimStatus: "VERIFIED",
                walletTransactionCreated: false,
              },
            },
          });
          responseStatus = 201;
          responseBody = jsonSafe({
            success: true,
            data: {
              claim: claimMutationToResponse(completedClaim),
              verificationComplete: true,
              nextRequiredVerification: null,
              walletTransactionCreated: false,
              nextPhase: "PHASE_6_SIMULATED_WALLET_TRANSACTION",
            },
          });
        } else {
          await tx.claim.update({
            where: { claimId: existingClaim.claimId },
            data: { isDuplicateFlag: true },
          });
          const scanLogId = await createScanAttempt(tx, req, {
            distributionId,
            submittedTokenHash,
            qrTokenId: qrToken.qrTokenId,
            claimId: existingClaim.claimId,
            scanResult: "DUPLICATE",
            deviceInfo,
          });
          responseStatus = 409;
          responseBody = failureBody(
            req,
            "DUPLICATE_CLAIM",
            "A claim already exists for this beneficiary and distribution event.",
            { scanLogId, claimId: existingClaim.claimId },
          );
        }
      } else if (schedule?.status !== "SCHEDULED") {
        const scanLogId = await createScanAttempt(tx, req, {
          distributionId,
          submittedTokenHash,
          qrTokenId: qrToken.qrTokenId,
          scanResult: "INVALID_SCHEDULE",
          deviceInfo,
        });
        responseStatus = 409;
        responseBody = failureBody(
          req,
          "SCHEDULE_NOT_CLAIMABLE",
          "The beneficiary does not have an active claimable schedule.",
          { scanLogId },
        );
      } else if (allocation?.allocationStatus !== "ALLOCATED") {
        const scanLogId = await createScanAttempt(tx, req, {
          distributionId,
          submittedTokenHash,
          qrTokenId: qrToken.qrTokenId,
          scanResult: "INVALID_ALLOCATION",
          deviceInfo,
        });
        responseStatus = 409;
        responseBody = failureBody(
          req,
          "ALLOCATION_NOT_CLAIMABLE",
          "The beneficiary does not have an active claimable allocation.",
          { scanLogId },
        );
      } else {
        const verificationComplete = distribution.verificationRequirement === "QR";
        const createdClaim = await tx.claim.create({
          data: {
            beneficiaryId: qrToken.beneficiaryId,
            distributionId,
            scheduleId: schedule.scheduleId,
            verifiedById: req.auth.userId,
            allocationId: allocation.allocationId,
            claimStatus: verificationComplete ? "VERIFIED" : "PENDING",
            verificationMethod: distribution.verificationRequirement,
            biometricVerified: false,
            qrVerified: true,
            isDuplicateFlag: false,
          },
          select: claimMutationSelect,
        });
        const tokenUpdate = await tx.qrToken.updateMany({
          where: {
            qrTokenId: qrToken.qrTokenId,
            distributionId,
            qrStatus: "ACTIVE",
            expiresAt: { gt: now },
          },
          data: { qrStatus: "USED" },
        });
        const scheduleUpdate = await tx.schedule.updateMany({
          where: { scheduleId: schedule.scheduleId, status: "SCHEDULED" },
          data: { status: "CHECKED_IN" },
        });
        if (tokenUpdate.count !== 1 || scheduleUpdate.count !== 1) {
          throw new AppError(
            409,
            "QR_CLAIM_CONCURRENT_CHANGE",
            "QR token or schedule changed during verification.",
          );
        }
        await createScanAttempt(tx, req, {
          distributionId,
          submittedTokenHash,
          qrTokenId: qrToken.qrTokenId,
          claimId: createdClaim.claimId,
          scanResult: verificationComplete ? "VERIFIED" : "PENDING_BIOMETRIC",
          deviceInfo,
        });
        await tx.auditLog.create({
          data: {
            userId: req.auth.userId,
            action: verificationComplete ? "CLAIM_VERIFIED_BY_QR" : "CLAIM_AWAITING_BIOMETRIC",
            entityAffected: "CLAIM",
            recordId: createdClaim.claimId,
            ipAddress: clientIpAddress(req),
            details: {
              distributionId,
              beneficiaryId: qrToken.beneficiaryId,
              scheduleId: schedule.scheduleId,
              allocationId: allocation.allocationId,
              claimStatus: createdClaim.claimStatus,
              verificationRequirement: distribution.verificationRequirement,
              walletTransactionCreated: false,
            },
          },
        });
        responseStatus = 201;
        responseBody = jsonSafe({
          success: true,
          data: {
            claim: claimMutationToResponse(createdClaim),
            verificationComplete,
            nextRequiredVerification: verificationComplete ? null : "BIOMETRIC",
            walletTransactionCreated: false,
            nextPhase: verificationComplete
              ? "PHASE_6_SIMULATED_WALLET_TRANSACTION"
              : "PHASE_7_BIOMETRIC_VERIFICATION",
          },
        });
      }
    }

    await tx.idempotencyRecord.create({
      data: {
        ...identity,
        requestHash,
        responseStatus,
        responseBody,
        expiresAt: new Date(now.getTime() + env.idempotencyTtlHours * 60 * 60 * 1000),
      },
    });
    return { replayed: false, responseStatus, responseBody };
  });

  res.set("Idempotency-Replayed", String(result.replayed));
  await publishQrVerificationResult(distributionId, result);
  return res.status(result.responseStatus).json(result.responseBody);
});

export const listClaims = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { page, pageSize, status, search } = req.validatedQuery;
  await getDistributionClaimParentOrThrow(distributionId, req.staffUser);
  const where = {
    distributionId,
    ...(status ? { claimStatus: status } : {}),
    ...buildClaimSearchWhere(search),
  };
  const [claims, total, statusGroups] = await Promise.all([
    prisma.claim.findMany({
      where,
      select: claimPublicSelect,
      orderBy: [{ createdAt: "desc" }, { claimId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.claim.count({ where }),
    prisma.claim.groupBy({
      by: ["claimStatus"],
      where: { distributionId },
      _count: { _all: true },
    }),
  ]);
  return res.status(200).json({
    success: true,
    data: {
      claims: claims.map(claimToResponse),
      summary: {
        matchingClaimCount: total,
        countsByStatus: Object.fromEntries(
          statusGroups.map((group) => [group.claimStatus, group._count._all]),
        ),
      },
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
  });
});

export const getClaim = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId, claimId } = req.validatedParams;
  await getDistributionClaimParentOrThrow(distributionId, req.staffUser);
  const claim = await getClaimOrThrow(distributionId, claimId);
  return res.status(200).json({ success: true, data: { claim: claimToResponse(claim) } });
});

export const listQrScanLogs = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { page, pageSize, result, qrTokenId, claimId } = req.validatedQuery;
  await getDistributionClaimParentOrThrow(distributionId, req.staffUser);
  const where = {
    distributionId,
    ...(result ? { scanResult: result } : {}),
    ...(qrTokenId ? { qrTokenId } : {}),
    ...(claimId ? { claimId } : {}),
  };
  const [scanLogs, total] = await Promise.all([
    prisma.qrScanLog.findMany({
      where,
      select: qrScanLogPublicSelect,
      orderBy: [{ scannedAt: "desc" }, { scanLogId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.qrScanLog.count({ where }),
  ]);
  return res.status(200).json({
    success: true,
    data: {
      scanLogs,
      summary: { matchingScanLogCount: total },
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
  });
});
