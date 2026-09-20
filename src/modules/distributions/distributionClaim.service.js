import { createHash, randomBytes } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { distributionAccessWhere } from "./distribution.policy.js";
import { distributionSlotToResponse } from "./distributionSlot.service.js";

const PHILIPPINE_OFFSET = "+08:00";

export const claimBeneficiarySelect = {
  beneficiaryId: true,
  firstName: true,
  middleName: true,
  lastName: true,
  barangayId: true,
  sitioPurok: true,
  status: true,
  barangay: {
    select: {
      barangayId: true,
      barangayCode: true,
      barangayName: true,
      city: true,
      province: true,
    },
  },
};

export const qrEligibleScheduleSelect = {
  scheduleId: true,
  distributionId: true,
  beneficiaryId: true,
  slotId: true,
  queueNumber: true,
  status: true,
  beneficiary: { select: claimBeneficiarySelect },
  slot: {
    select: {
      slotId: true,
      distributionId: true,
      sessionId: true,
      sessionLabel: true,
      location: true,
      serviceAreas: true,
      slotStart: true,
      slotEnd: true,
      capacity: true,
      slotStatus: true,
      createdAt: true,
      updatedAt: true,
    },
  },
};

export const qrTokenPublicSelect = {
  qrTokenId: true,
  beneficiaryId: true,
  distributionId: true,
  qrStatus: true,
  expiresAt: true,
  createdAt: true,
  beneficiary: { select: claimBeneficiarySelect },
};

export const claimPublicSelect = {
  claimId: true,
  beneficiaryId: true,
  distributionId: true,
  scheduleId: true,
  verifiedById: true,
  allocationId: true,
  claimStatus: true,
  verificationMethod: true,
  biometricVerified: true,
  biometricScore: true,
  qrVerified: true,
  signatureVerified: true,
  isDuplicateFlag: true,
  releaseMethod: true,
  releasedById: true,
  releasedAt: true,
  releaseEvidenceType: true,
  releaseEvidenceReference: true,
  releaseNotes: true,
  claimedAt: true,
  createdAt: true,
  updatedAt: true,
  beneficiary: { select: claimBeneficiarySelect },
  distribution: {
    select: {
      distributionId: true,
      title: true,
      status: true,
      deliveryMode: true,
      verificationRequirement: true,
    },
  },
  schedule: {
    select: {
      scheduleId: true,
      slotId: true,
      queueNumber: true,
      status: true,
      slot: {
        select: {
          slotId: true,
          distributionId: true,
          sessionId: true,
          sessionLabel: true,
          location: true,
          serviceAreas: true,
          slotStart: true,
          slotEnd: true,
          capacity: true,
          slotStatus: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  },
  allocation: {
    select: {
      allocationId: true,
      amount: true,
      allocationStatus: true,
    },
  },
  verifiedBy: {
    select: {
      userId: true,
      employeeId: true,
      username: true,
      fullName: true,
      role: true,
    },
  },
  releasedBy: {
    select: {
      userId: true,
      employeeId: true,
      username: true,
      fullName: true,
      role: true,
    },
  },
  receipt: {
    select: {
      receiptId: true,
      receiptNo: true,
      evidenceHash: true,
      issuedAt: true,
      printCount: true,
    },
  },
  disputes: {
    orderBy: { filedAt: "desc" },
    take: 1,
    select: {
      disputeId: true,
      referenceNo: true,
      status: true,
      reasonCode: true,
      outcome: true,
      filedAt: true,
    },
  },
};

export const claimMutationSelect = {
  claimId: true,
  beneficiaryId: true,
  distributionId: true,
  scheduleId: true,
  verifiedById: true,
  allocationId: true,
  claimStatus: true,
  verificationMethod: true,
  biometricVerified: true,
  biometricScore: true,
  qrVerified: true,
  signatureVerified: true,
  isDuplicateFlag: true,
  releaseMethod: true,
  releasedById: true,
  releasedAt: true,
  releaseEvidenceType: true,
  releaseEvidenceReference: true,
  releaseNotes: true,
  claimedAt: true,
  createdAt: true,
  updatedAt: true,
  beneficiary: { select: claimBeneficiarySelect },
  schedule: {
    select: {
      scheduleId: true,
      queueNumber: true,
      status: true,
    },
  },
};

export const qrScanLogPublicSelect = {
  scanLogId: true,
  qrTokenId: true,
  claimId: true,
  scannedById: true,
  scanResult: true,
  deviceInfo: true,
  scannedAt: true,
  qrToken: {
    select: {
      qrTokenId: true,
      beneficiaryId: true,
      distributionId: true,
      qrStatus: true,
      expiresAt: true,
    },
  },
  claim: {
    select: {
      claimId: true,
      beneficiaryId: true,
      distributionId: true,
      claimStatus: true,
    },
  },
  scannedBy: {
    select: {
      userId: true,
      employeeId: true,
      username: true,
      fullName: true,
      role: true,
    },
  },
};

export const distributionClaimParentSelect = {
  distributionId: true,
  distributionDate: true,
  endTime: true,
  barangayId: true,
  status: true,
  deliveryMode: true,
  verificationRequirement: true,
};

export function hashQrToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateRawQrToken() {
  return `gya1_${randomBytes(32).toString("base64url")}`;
}

function timeMinutes(value) {
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}

function minutesAsTime(minutes) {
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return `${hours}:${minute}`;
}

export function distributionQrExpiry(distribution, slotEnd) {
  if (slotEnd) return new Date(slotEnd);
  const dateOnly = distribution.distributionDate.toISOString().slice(0, 10);
  return new Date(
    `${dateOnly}T${minutesAsTime(timeMinutes(distribution.endTime))}:00${PHILIPPINE_OFFSET}`,
  );
}

export function effectiveQrStatus(qrToken, now = new Date()) {
  if (qrToken.qrStatus === "ACTIVE" && qrToken.expiresAt <= now) {
    return "EXPIRED";
  }
  return qrToken.qrStatus;
}

export function qrClaimPreviewOutcome({ distribution, qrToken, schedule, allocation, existingClaim, now = new Date() }) {
  if (!qrToken) return { ok: false, statusCode: 404, code: "INVALID_QR_TOKEN", message: "The QR credential is invalid for this distribution event.", scanResult: "INVALID_TOKEN" };
  const status = effectiveQrStatus(qrToken, now);
  if (status === "USED") return { ok: false, statusCode: 409, code: "QR_TOKEN_ALREADY_USED", message: "This QR credential has already been used.", scanResult: "DUPLICATE" };
  if (status === "REVOKED") return { ok: false, statusCode: 409, code: "QR_TOKEN_REVOKED", message: "This QR credential has been revoked.", scanResult: "REVOKED" };
  if (status === "EXPIRED") return { ok: false, statusCode: 410, code: "QR_TOKEN_EXPIRED", message: "This QR credential has expired.", scanResult: "EXPIRED" };

  const completesCombinedVerification = distribution.verificationRequirement === "QR_AND_BIOMETRIC"
    && existingClaim?.claimStatus === "PENDING"
    && existingClaim.biometricVerified
    && !existingClaim.qrVerified;
  if (existingClaim && !completesCombinedVerification) return { ok: false, statusCode: 409, code: "DUPLICATE_CLAIM", message: "A claim already exists for this beneficiary and distribution event.", scanResult: "DUPLICATE" };
  if (!existingClaim && schedule?.status !== "SCHEDULED") return { ok: false, statusCode: 409, code: "SCHEDULE_NOT_CLAIMABLE", message: "The beneficiary does not have an active claimable schedule.", scanResult: "INVALID_SCHEDULE" };
  if (!existingClaim && allocation?.allocationStatus !== "ALLOCATED") return { ok: false, statusCode: 409, code: "ALLOCATION_NOT_CLAIMABLE", message: "The beneficiary does not have an active claimable allocation.", scanResult: "INVALID_ALLOCATION" };

  const verificationCompleteAfterConfirm = distribution.verificationRequirement === "QR" || completesCombinedVerification;
  return {
    ok: true,
    checksInBeneficiary: schedule?.status === "SCHEDULED",
    verificationCompleteAfterConfirm,
    nextRequiredVerification: verificationCompleteAfterConfirm ? null : "BIOMETRIC",
  };
}

export function qrTokenToResponse(qrToken, now = new Date()) {
  return {
    ...qrToken,
    qrStatus: effectiveQrStatus(qrToken, now),
  };
}

export function qrEligibleScheduleToResponse(schedule) {
  return {
    ...schedule,
    slot: distributionSlotToResponse(schedule.slot),
  };
}

export function claimToResponse(claim) {
  return {
    ...claim,
    biometricScore: claim.biometricScore?.toString() ?? null,
    allocation: {
      ...claim.allocation,
      amount: claim.allocation.amount.toString(),
    },
    schedule: {
      ...claim.schedule,
      slot: distributionSlotToResponse(claim.schedule.slot),
    },
  };
}

export function claimMutationToResponse(claim) {
  return {
    ...claim,
    biometricScore: claim.biometricScore?.toString() ?? null,
  };
}

export function assertDistributionOpenForClaims(distribution) {
  if (distribution.status !== "OPEN") {
    throw new AppError(
      409,
      "DISTRIBUTION_NOT_OPEN_FOR_CLAIMS",
      "QR tokens and claim verification require an open distribution event.",
    );
  }
}

export function claimIdentityRequirementSatisfied(claim) {
  const verificationMethod = claim.verificationMethod
    ?? (claim.qrVerified ? "QR" : "BIOMETRIC");
  return {
    QR: claim.qrVerified,
    BIOMETRIC: claim.biometricVerified,
    QR_AND_BIOMETRIC: claim.qrVerified && claim.biometricVerified,
    BIOMETRIC_AND_SIGNATURE: claim.biometricVerified && claim.signatureVerified,
    MANUAL: false,
  }[verificationMethod] ?? false;
}

export function assertPhysicalClaimReleasable(claim, distribution) {
  if (distribution.deliveryMode !== "PHYSICAL_GOODS") {
    throw new AppError(
      409,
      "DISTRIBUTION_NOT_PHYSICAL_GOODS",
      "Only a PHYSICAL_GOODS distribution can use the physical release workflow.",
    );
  }
  if (distribution.status !== "OPEN") {
    throw new AppError(
      409,
      "DISTRIBUTION_NOT_OPEN_FOR_RELEASE",
      "Physical assistance can only be released while the distribution event is OPEN.",
    );
  }
  if (claim.claimStatus !== "VERIFIED" || claim.releasedAt || claim.releaseMethod) {
    throw new AppError(
      409,
      "CLAIM_NOT_RELEASABLE",
      "Only an unreleased VERIFIED claim can be marked as physically released.",
    );
  }
  if (claim.disputes?.some((dispute) => ["OPEN", "UNDER_REVIEW", "REFERRED"].includes(dispute.status))) {
    throw new AppError(
      409,
      "ACTIVE_CLAIM_DISPUTE",
      "Resolve the active claim dispute before releasing physical assistance.",
    );
  }
  if (!claimIdentityRequirementSatisfied(claim)) {
    throw new AppError(
      409,
      "CLAIM_IDENTITY_NOT_VERIFIED",
      "The configured QR, biometric, or signature verification is not complete.",
    );
  }
  if (claim.allocation?.allocationStatus !== "ALLOCATED") {
    throw new AppError(
      409,
      "ALLOCATION_NOT_RELEASABLE",
      "The claim allocation must be ALLOCATED before physical assistance release.",
    );
  }
  if (claim.schedule?.status !== "CHECKED_IN") {
    throw new AppError(
      409,
      "SCHEDULE_NOT_CHECKED_IN",
      "The beneficiary schedule must be CHECKED_IN before physical assistance release.",
    );
  }
  if (claim.beneficiary?.status !== "ACTIVE") {
    throw new AppError(
      409,
      "BENEFICIARY_NOT_ACTIVE",
      "Physical assistance can only be released to an active beneficiary.",
    );
  }
}

export function assertQrVerificationConfigured(distribution) {
  if (!["QR", "QR_AND_BIOMETRIC"].includes(distribution.verificationRequirement)) {
    throw new AppError(
      409,
      "QR_NOT_REQUIRED",
      "This distribution event does not use QR verification.",
    );
  }
}

export function assertQrTokenRevocable(qrToken, now = new Date()) {
  const status = effectiveQrStatus(qrToken, now);
  if (status !== "ACTIVE") {
    throw new AppError(
      409,
      "QR_TOKEN_NOT_REVOCABLE",
      `A QR token with ${status} status cannot be revoked.`,
    );
  }
}

export function assertQrTokenReissuable(qrToken, now = new Date()) {
  const status = effectiveQrStatus(qrToken, now);
  if (!["REVOKED", "EXPIRED"].includes(status)) {
    throw new AppError(
      409,
      "QR_TOKEN_NOT_REISSUABLE",
      `A QR token with ${status} status cannot be reissued.`,
    );
  }
}

export function buildQrStatusWhere(status, now = new Date()) {
  if (!status) {
    return {};
  }
  if (status === "ACTIVE") {
    return { qrStatus: "ACTIVE", expiresAt: { gt: now } };
  }
  if (status === "EXPIRED") {
    return {
      OR: [
        { qrStatus: "EXPIRED" },
        { qrStatus: "ACTIVE", expiresAt: { lte: now } },
      ],
    };
  }
  return { qrStatus: status };
}

export function buildClaimSearchWhere(search) {
  if (!search) {
    return {};
  }
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(search);
  return {
    OR: [
      ...(isUuid ? [
        { claimId: search },
        { beneficiaryId: search },
        { scheduleId: search },
        { allocationId: search },
      ] : []),
      { beneficiary: { firstName: { contains: search, mode: "insensitive" } } },
      { beneficiary: { middleName: { contains: search, mode: "insensitive" } } },
      { beneficiary: { lastName: { contains: search, mode: "insensitive" } } },
    ],
  };
}

export function buildQrSearchWhere(search) {
  if (!search) {
    return {};
  }
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(search);
  return {
    OR: [
      ...(isUuid ? [{ qrTokenId: search }, { beneficiaryId: search }] : []),
      { beneficiary: { firstName: { contains: search, mode: "insensitive" } } },
      { beneficiary: { middleName: { contains: search, mode: "insensitive" } } },
      { beneficiary: { lastName: { contains: search, mode: "insensitive" } } },
    ],
  };
}

export async function getDistributionClaimParentOrThrow(
  distributionId,
  staffUser,
  database = prisma,
) {
  const distribution = await database.distribution.findFirst({
    where: { distributionId, ...distributionAccessWhere(staffUser) },
    select: distributionClaimParentSelect,
  });
  if (!distribution) {
    throw new AppError(404, "DISTRIBUTION_NOT_FOUND", "Distribution event was not found.");
  }
  return distribution;
}

export async function getQrTokenOrThrow(distributionId, qrTokenId, database = prisma) {
  const qrToken = await database.qrToken.findFirst({
    where: { distributionId, qrTokenId },
    select: qrTokenPublicSelect,
  });
  if (!qrToken) {
    throw new AppError(404, "QR_TOKEN_NOT_FOUND", "QR token record was not found.");
  }
  return qrToken;
}

export async function getClaimOrThrow(distributionId, claimId, database = prisma) {
  const claim = await database.claim.findFirst({
    where: { distributionId, claimId },
    select: claimPublicSelect,
  });
  if (!claim) {
    throw new AppError(404, "CLAIM_NOT_FOUND", "Claim verification record was not found.");
  }
  return claim;
}
