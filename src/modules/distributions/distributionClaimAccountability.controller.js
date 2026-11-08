import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import {
  assertClaimDisputeFileAllowed,
  assertClaimDisputeReviewAllowed,
  assertDistributionReadAllowed,
} from "./distribution.policy.js";
import { getDistributionClaimParentOrThrow } from "./distributionClaim.service.js";
import {
  ACTIVE_CLAIM_DISPUTE_STATUSES,
  assertClaimReceiptAvailable,
  assertDisputeCanBeFiled,
  buildClaimReceiptSnapshot,
  buildDisputeSearchWhere,
  claimDisputePublicSelect,
  claimDisputeToResponse,
  claimReceiptEvidenceHash,
  claimReceiptPublicSelect,
  claimReceiptSourceSelect,
  claimReceiptToResponse,
  disputeReviewUpdate,
  generateClaimReceiptNo,
  generateDisputeReference,
} from "./distributionClaimAccountability.service.js";

function claimNotFound() {
  throw new AppError(404, "CLAIM_NOT_FOUND", "Claim verification record was not found.");
}

export const issueClaimReceipt = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId, claimId } = req.validatedParams;
  await getDistributionClaimParentOrThrow(distributionId, req.staffUser);

  const result = await prisma.$transaction(async (tx) => {
    const claim = await tx.claim.findFirst({
      where: { claimId, distributionId },
      select: claimReceiptSourceSelect,
    });
    if (!claim) claimNotFound();
    assertClaimReceiptAvailable(claim);

    const snapshot = buildClaimReceiptSnapshot(claim);
    const receiptNo = generateClaimReceiptNo();
    const receipt = await tx.claimReceipt.upsert({
      where: { claimId },
      update: {},
      create: {
        claimId,
        issuedById: req.auth.userId,
        receiptNo,
        evidenceHash: claimReceiptEvidenceHash(snapshot),
        snapshot,
      },
      select: claimReceiptPublicSelect,
    });
    const created = receipt.receiptNo === receiptNo;
    if (created) await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "CLAIM_RECEIPT_ISSUED",
        entityAffected: "CLAIM_RECEIPT",
        recordId: receipt.receiptId,
        ipAddress: clientIpAddress(req),
        details: {
          claimId,
          distributionId,
          receiptNo: receipt.receiptNo,
          evidenceHash: receipt.evidenceHash,
        },
      },
    });
    return { receipt, created };
  }).catch(async (error) => {
    // A competing upsert can win before this transaction inserts its receipt.
    if (error.code === "P2002") {
      const receipt = await prisma.claimReceipt.findFirst({
        where: { claimId, claim: { distributionId } },
        select: claimReceiptPublicSelect,
      });
      if (receipt) return { receipt, created: false };
    }
    throw error;
  });

  return res.status(result.created ? 201 : 200).json({
    success: true,
    data: { receipt: claimReceiptToResponse(result.receipt), created: result.created },
  });
});

export const recordClaimReceiptPrint = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId, claimId } = req.validatedParams;
  await getDistributionClaimParentOrThrow(distributionId, req.staffUser);

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.claimReceipt.findFirst({
      where: { claimId, claim: { distributionId } },
      select: { receiptId: true },
    });
    if (!existing) {
      throw new AppError(404, "CLAIM_RECEIPT_NOT_FOUND", "Issue the claim receipt before printing it.");
    }
    const receipt = await tx.claimReceipt.update({
      where: { receiptId: existing.receiptId },
      data: { printCount: { increment: 1 }, lastPrintedAt: new Date() },
      select: claimReceiptPublicSelect,
    });
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "CLAIM_RECEIPT_PRINT_REQUESTED",
        entityAffected: "CLAIM_RECEIPT",
        recordId: receipt.receiptId,
        ipAddress: clientIpAddress(req),
        details: { claimId, distributionId, receiptNo: receipt.receiptNo },
      },
    });
    return receipt;
  });

  return res.status(200).json({
    success: true,
    data: { receipt: claimReceiptToResponse(result) },
  });
});

export const createClaimDispute = asyncHandler(async (req, res) => {
  assertClaimDisputeFileAllowed(req.staffUser);
  const { distributionId, claimId } = req.validatedParams;
  const { reasonCode, statement } = req.validatedBody;
  await getDistributionClaimParentOrThrow(distributionId, req.staffUser);

  const dispute = await prisma.$transaction(async (tx) => {
    const claim = await tx.claim.findFirst({
      where: { claimId, distributionId },
      select: { claimId: true, claimStatus: true, isDuplicateFlag: true },
    });
    if (!claim) claimNotFound();
    const activeCount = await tx.claimDispute.count({
      where: { claimId, status: { in: ACTIVE_CLAIM_DISPUTE_STATUSES } },
    });
    assertDisputeCanBeFiled(claim, activeCount);

    const created = await tx.claimDispute.create({
      data: {
        claimId,
        filedById: req.auth.userId,
        referenceNo: generateDisputeReference(),
        reasonCode,
        statement,
      },
      select: claimDisputePublicSelect,
    });
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "CLAIM_DISPUTE_FILED",
        entityAffected: "CLAIM_DISPUTE",
        recordId: created.disputeId,
        ipAddress: clientIpAddress(req),
        details: {
          claimId,
          distributionId,
          referenceNo: created.referenceNo,
          reasonCode,
          beneficiaryPresent: true,
        },
      },
    });
    return created;
  }, { isolationLevel: "Serializable" }).catch((error) => {
    if (error.code === "P2034") {
      throw new AppError(
        409,
        "CLAIM_DISPUTE_CONCURRENT_CHANGE",
        "The claim changed while the concern was being filed. Reload the claim and check its current state before retrying.",
      );
    }
    if (error.code === "P2002") {
      throw new AppError(
        409,
        "ACTIVE_CLAIM_DISPUTE_EXISTS",
        "This claim already has an active dispute. Continue that case instead of creating another.",
      );
    }
    throw error;
  });

  return res.status(201).json({
    success: true,
    data: { dispute: claimDisputeToResponse(dispute) },
  });
});

export const listClaimDisputes = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { page, pageSize, status, search } = req.validatedQuery;
  await getDistributionClaimParentOrThrow(distributionId, req.staffUser);
  const where = {
    claim: { distributionId },
    ...(status ? { status } : {}),
    ...buildDisputeSearchWhere(search),
  };
  const [disputes, total, statusGroups] = await Promise.all([
    prisma.claimDispute.findMany({
      where,
      select: claimDisputePublicSelect,
      orderBy: [{ filedAt: "desc" }, { disputeId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.claimDispute.count({ where }),
    prisma.claimDispute.groupBy({
      by: ["status"],
      where: { claim: { distributionId } },
      _count: { _all: true },
    }),
  ]);

  return res.status(200).json({
    success: true,
    data: {
      disputes: disputes.map(claimDisputeToResponse),
      summary: {
        matchingDisputeCount: total,
        countsByStatus: Object.fromEntries(
          statusGroups.map((group) => [group.status, group._count._all]),
        ),
      },
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
  });
});

export const reviewClaimDispute = asyncHandler(async (req, res) => {
  assertClaimDisputeReviewAllowed(req.staffUser);
  const { distributionId, disputeId } = req.validatedParams;
  const { action, reviewNotes, expectedUpdatedAt, expectedClaimUpdatedAt } = req.validatedBody;
  await getDistributionClaimParentOrThrow(distributionId, req.staffUser);

  const dispute = await prisma.$transaction(async (tx) => {
    const current = await tx.claimDispute.findFirst({
      where: { disputeId, claim: { distributionId } },
      select: claimDisputePublicSelect,
    });
    if (!current) {
      throw new AppError(404, "CLAIM_DISPUTE_NOT_FOUND", "Claim dispute was not found.");
    }
    if (current.updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()) {
      throw new AppError(409, "CLAIM_DISPUTE_CONCURRENT_CHANGE", "This case changed after you opened it. Close the decision form and review the refreshed case before continuing.");
    }
    if (expectedClaimUpdatedAt && current.claim.updatedAt.getTime() !== new Date(expectedClaimUpdatedAt).getTime()) {
      throw new AppError(409, "CLAIM_DISPUTE_CONCURRENT_CHANGE", "The claim evidence changed after you opened this case. Close the decision form and review the refreshed evidence before continuing.");
    }
    const change = disputeReviewUpdate(current, action, req.auth.userId, reviewNotes);
    if (action !== "START_REVIEW") {
      const claimUpdate = await tx.claim.updateMany({
        where: {
          claimId: current.claimId,
          claimStatus: change.claimExpectedStatus ?? current.claim.claimStatus,
          updatedAt: new Date(expectedClaimUpdatedAt),
        },
        // Even a decision without claim changes must lock the evidence version until commit.
        data: change.claimData ?? { updatedAt: new Date(expectedClaimUpdatedAt) },
      });
      if (claimUpdate.count !== 1) {
        throw new AppError(409, "CLAIM_DISPUTE_CONCURRENT_CHANGE", "The claim changed during review. Reload the case.");
      }
      if (change.claimData) await tx.auditLog.create({
        data: {
          userId: req.auth.userId,
          action: change.claimData.isDuplicateFlag === false ? "CLAIM_DUPLICATE_FLAG_CLEARED_AFTER_REVIEW" : "CLAIM_VOIDED_AFTER_DISPUTE",
          entityAffected: "CLAIM",
          recordId: current.claimId,
          ipAddress: clientIpAddress(req),
          details: {
            disputeId,
            distributionId,
            referenceNo: current.referenceNo,
            releaseMethod: current.claim.releaseMethod,
            walletReversalRequired: change.claimData.claimStatus === "VOIDED" && current.claim.releaseMethod !== "PHYSICAL_GOODS"
              && current.claim.distribution?.deliveryMode !== "PHYSICAL_GOODS",
          },
        },
      });
    }
    const disputeUpdate = await tx.claimDispute.updateMany({
      where: {
        disputeId,
        updatedAt: new Date(expectedUpdatedAt),
        ...(action === "START_REVIEW"
          ? { status: "OPEN", assignedToId: null }
          : { status: { in: ["UNDER_REVIEW", "REFERRED"] }, assignedToId: req.auth.userId }),
      },
      data: change.disputeData,
    });
    if (disputeUpdate.count !== 1) {
      throw new AppError(409, "CLAIM_DISPUTE_CONCURRENT_CHANGE", "The dispute changed during review. Reload the case.");
    }
    const updated = await tx.claimDispute.findUniqueOrThrow({
      where: { disputeId },
      select: claimDisputePublicSelect,
    });
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: {
          START_REVIEW: "CLAIM_DISPUTE_REVIEW_STARTED",
          REFER_FOR_INVESTIGATION: "CLAIM_DISPUTE_REFERRED",
          CONFIRM_CLAIM: "CLAIM_DISPUTE_CLAIM_CONFIRMED",
          COMPLETE_REMEDIATION: "CLAIM_DISPUTE_REMEDIATED",
        }[action],
        entityAffected: "CLAIM_DISPUTE",
        recordId: disputeId,
        ipAddress: clientIpAddress(req),
        details: {
          claimId: current.claimId,
          distributionId,
          referenceNo: current.referenceNo,
          action,
          resultingStatus: change.disputeData.status,
        },
      },
    });
    return updated;
  });

  return res.status(200).json({
    success: true,
    data: { dispute: claimDisputeToResponse(dispute) },
  });
});
