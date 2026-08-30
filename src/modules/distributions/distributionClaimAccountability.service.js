import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../../utils/AppError.js";

export const ACTIVE_CLAIM_DISPUTE_STATUSES = Object.freeze([
  "OPEN",
  "UNDER_REVIEW",
  "REFERRED",
]);

const staffSelect = {
  userId: true,
  employeeId: true,
  fullName: true,
  role: true,
};

export const claimReceiptSourceSelect = {
  claimId: true,
  claimStatus: true,
  verificationMethod: true,
  biometricVerified: true,
  qrVerified: true,
  signatureVerified: true,
  claimedAt: true,
  updatedAt: true,
  beneficiary: {
    select: {
      beneficiaryId: true,
      firstName: true,
      middleName: true,
      lastName: true,
      sitioPurok: true,
      barangay: { select: { barangayName: true } },
    },
  },
  distribution: {
    select: {
      distributionId: true,
      title: true,
      distributionDate: true,
      startTime: true,
      endTime: true,
      location: true,
      verificationRequirement: true,
      program: { select: { programCode: true, programName: true } },
      barangay: { select: { barangayName: true } },
    },
  },
  schedule: {
    select: {
      queueNumber: true,
      status: true,
      slot: {
        select: {
          sessionLabel: true,
          location: true,
          slotStart: true,
          slotEnd: true,
        },
      },
    },
  },
  allocation: { select: { amount: true, allocationStatus: true } },
  verifiedBy: { select: staffSelect },
  signature: {
    select: {
      imageSha256: true,
      signatureMethod: true,
      pointCount: true,
      signedAt: true,
      capturedBy: { select: staffSelect },
    },
  },
  biometricAttempts: {
    where: { result: "MATCHED" },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      result: true,
      matchScore: true,
      livenessScore: true,
      processor: true,
      createdAt: true,
      verifiedBy: { select: staffSelect },
    },
  },
  transactions: {
    where: { transactionType: "BENEFIT_CREDIT" },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      referenceNo: true,
      status: true,
      createdAt: true,
      initiatedBy: { select: staffSelect },
    },
  },
};

export const claimReceiptPublicSelect = {
  receiptId: true,
  claimId: true,
  receiptNo: true,
  receiptVersion: true,
  evidenceHash: true,
  snapshot: true,
  printCount: true,
  lastPrintedAt: true,
  issuedAt: true,
  issuedBy: { select: staffSelect },
  claim: { select: { claimStatus: true, distributionId: true } },
};

export const claimDisputePublicSelect = {
  disputeId: true,
  claimId: true,
  referenceNo: true,
  status: true,
  reasonCode: true,
  statement: true,
  outcome: true,
  reviewNotes: true,
  filedAt: true,
  reviewedAt: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  filedBy: { select: staffSelect },
  assignedTo: { select: staffSelect },
  reviewedBy: { select: staffSelect },
  claim: {
    select: {
      claimId: true,
      claimStatus: true,
      verificationMethod: true,
      claimedAt: true,
      beneficiary: {
        select: {
          beneficiaryId: true,
          firstName: true,
          middleName: true,
          lastName: true,
          sitioPurok: true,
          barangay: { select: { barangayName: true } },
        },
      },
      allocation: { select: { amount: true, allocationStatus: true } },
      receipt: {
        select: {
          receiptId: true,
          receiptNo: true,
          evidenceHash: true,
          issuedAt: true,
        },
      },
    },
  },
};

function fullName(person) {
  return [person.firstName, person.middleName, person.lastName].filter(Boolean).join(" ");
}

function decimalString(value) {
  return value?.toString() ?? null;
}

function iso(value) {
  return value?.toISOString() ?? null;
}

export function assertClaimReceiptAvailable(claim) {
  if (!["CLAIMED", "VOIDED"].includes(claim?.claimStatus)) {
    throw new AppError(
      409,
      "CLAIM_RECEIPT_NOT_AVAILABLE",
      "A final claim receipt is available only after settlement, or after a settled claim is voided.",
    );
  }
}

export function buildClaimReceiptSnapshot(claim) {
  const biometric = claim.biometricAttempts[0] ?? null;
  const transaction = claim.transactions[0] ?? null;
  return {
    beneficiary: {
      beneficiaryId: claim.beneficiary.beneficiaryId,
      fullName: fullName(claim.beneficiary),
      barangayName: claim.beneficiary.barangay.barangayName,
      sitioPurok: claim.beneficiary.sitioPurok,
    },
    distribution: {
      distributionId: claim.distribution.distributionId,
      title: claim.distribution.title,
      distributionDate: iso(claim.distribution.distributionDate),
      programCode: claim.distribution.program.programCode,
      programName: claim.distribution.program.programName,
      barangayName: claim.distribution.barangay.barangayName,
      location: claim.distribution.location,
    },
    claim: {
      claimId: claim.claimId,
      claimStatus: claim.claimStatus,
      verificationMethod: claim.verificationMethod,
      qrVerified: claim.qrVerified,
      biometricVerified: claim.biometricVerified,
      signatureVerified: claim.signatureVerified,
      verifiedAt: iso(claim.updatedAt),
      claimedAt: iso(claim.claimedAt),
    },
    service: {
      queueNumber: claim.schedule.queueNumber,
      scheduleStatus: claim.schedule.status,
      sessionLabel: claim.schedule.slot.sessionLabel,
      location: claim.schedule.slot.location,
      slotStart: iso(claim.schedule.slot.slotStart),
      slotEnd: iso(claim.schedule.slot.slotEnd),
    },
    assistance: {
      amount: decimalString(claim.allocation.amount),
      allocationStatus: claim.allocation.allocationStatus,
      currency: "PHP",
    },
    verificationEvidence: {
      verifiedBy: claim.verifiedBy,
      biometric: biometric
        ? {
            result: biometric.result,
            matchScore: decimalString(biometric.matchScore),
            livenessScore: decimalString(biometric.livenessScore),
            processor: biometric.processor,
            recordedAt: iso(biometric.createdAt),
            verifiedBy: biometric.verifiedBy,
          }
        : null,
      signature: claim.signature
        ? {
            imageSha256: claim.signature.imageSha256,
            method: claim.signature.signatureMethod,
            pointCount: claim.signature.pointCount,
            signedAt: iso(claim.signature.signedAt),
            capturedBy: claim.signature.capturedBy,
          }
        : null,
      transaction: transaction
        ? {
            referenceNo: transaction.referenceNo,
            status: transaction.status,
            recordedAt: iso(transaction.createdAt),
            processedBy: transaction.initiatedBy,
          }
        : null,
    },
  };
}

export function claimReceiptEvidenceHash(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex");
}

function governmentReference(prefix, now = new Date()) {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  return `GYA-${prefix}-${date}-${suffix}`;
}

export function generateClaimReceiptNo(now) {
  return governmentReference("CLM", now);
}

export function generateDisputeReference(now) {
  return governmentReference("DSP", now);
}

export function claimReceiptToResponse(receipt) {
  const { claim, ...publicReceipt } = receipt;
  return { ...publicReceipt, currentClaimStatus: claim.claimStatus };
}

export function claimDisputeToResponse(dispute) {
  return {
    ...dispute,
    claim: {
      ...dispute.claim,
      allocation: {
        ...dispute.claim.allocation,
        amount: decimalString(dispute.claim.allocation.amount),
      },
    },
  };
}

export function buildDisputeSearchWhere(search) {
  if (!search) return {};
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(search);
  return {
    OR: [
      ...(isUuid ? [{ disputeId: search }, { claimId: search }] : []),
      { referenceNo: { contains: search, mode: "insensitive" } },
      { claim: { beneficiary: { firstName: { contains: search, mode: "insensitive" } } } },
      { claim: { beneficiary: { middleName: { contains: search, mode: "insensitive" } } } },
      { claim: { beneficiary: { lastName: { contains: search, mode: "insensitive" } } } },
    ],
  };
}

export function assertDisputeCanBeFiled(claim, activeCount) {
  if (!["VERIFIED", "CLAIMED", "VOIDED"].includes(claim?.claimStatus)) {
    throw new AppError(
      409,
      "CLAIM_NOT_DISPUTABLE",
      "Only a verified, claimed, or voided claim may be disputed.",
    );
  }
  if (activeCount > 0) {
    throw new AppError(
      409,
      "ACTIVE_CLAIM_DISPUTE_EXISTS",
      "This claim already has an active dispute. Continue that case instead of creating another.",
    );
  }
}

export function assertIndependentReviewer(dispute, userId) {
  if (dispute.filedBy.userId === userId) {
    throw new AppError(
      409,
      "INDEPENDENT_REVIEW_REQUIRED",
      "The staff member who filed the dispute cannot review the same case.",
    );
  }
}

export function disputeReviewUpdate(dispute, action, userId, reviewNotes, now = new Date()) {
  assertIndependentReviewer(dispute, userId);
  if (action === "START_REVIEW") {
    if (dispute.status !== "OPEN") {
      throw new AppError(409, "DISPUTE_REVIEW_ALREADY_STARTED", "Only an OPEN dispute can be assigned.");
    }
    return {
      disputeData: { status: "UNDER_REVIEW", assignedToId: userId, reviewedAt: now },
    };
  }
  if (!dispute.assignedTo || dispute.assignedTo.userId !== userId) {
    throw new AppError(
      409,
      "DISPUTE_REVIEWER_MISMATCH",
      "Only the assigned independent reviewer may record this decision.",
    );
  }
  if (!["UNDER_REVIEW", "REFERRED"].includes(dispute.status)) {
    throw new AppError(409, "DISPUTE_NOT_REVIEWABLE", "This dispute is not awaiting a decision.");
  }
  if (action === "REFER_FOR_INVESTIGATION") {
    return {
      disputeData: {
        status: "REFERRED",
        outcome: "REFERRED_FOR_INVESTIGATION",
        reviewNotes,
        reviewedById: userId,
        reviewedAt: now,
      },
    };
  }
  if (action === "CONFIRM_CLAIM") {
    return {
      disputeData: {
        status: "RESOLVED",
        outcome: "CLAIM_CONFIRMED",
        reviewNotes,
        reviewedById: userId,
        reviewedAt: now,
        resolvedAt: now,
      },
    };
  }
  if (action === "COMPLETE_REMEDIATION") {
    if (dispute.claim.claimStatus === "CLAIMED") {
      throw new AppError(
        409,
        "CLAIM_REVERSAL_REQUIRED",
        "Reverse the completed benefit credit before resolving this dispute as remediated.",
      );
    }
    if (!["VERIFIED", "VOIDED"].includes(dispute.claim.claimStatus)) {
      throw new AppError(409, "CLAIM_NOT_REMEDIABLE", "This claim cannot be remediated in its current state.");
    }
    return {
      disputeData: {
        status: "RESOLVED",
        outcome: "BENEFICIARY_REMEDIATION",
        reviewNotes,
        reviewedById: userId,
        reviewedAt: now,
        resolvedAt: now,
      },
      claimData: dispute.claim.claimStatus === "VERIFIED" ? { claimStatus: "VOIDED" } : null,
    };
  }
  throw new AppError(400, "INVALID_DISPUTE_ACTION", "Unsupported dispute review action.");
}
