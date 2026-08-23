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
  isDuplicateFlag: true,
  claimedAt: true,
  createdAt: true,
  updatedAt: true,
  beneficiary: { select: claimBeneficiarySelect },
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
  isDuplicateFlag: true,
  claimedAt: true,
  createdAt: true,
  updatedAt: true,
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

export function distributionQrExpiry(distribution) {
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

export function assertQrVerificationConfigured(distribution) {
  if (distribution.verificationRequirement === "BIOMETRIC") {
    throw new AppError(
      409,
      "QR_NOT_REQUIRED",
      "This distribution event is configured for biometric verification only.",
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
