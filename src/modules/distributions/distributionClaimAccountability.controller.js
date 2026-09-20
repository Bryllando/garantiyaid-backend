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
      select: { claimId: true, claimStatus: true },
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
  }).catch((error) => {
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
  const { action, reviewNotes } = req.validatedBody;
  await getDistributionClaimParentOrThrow(distributionId, req.staffUser);

  const dispute = await prisma.$transaction(async (tx) => {
    const current = await tx.claimDispute.findFirst({
      where: { disputeId, claim: { distributionId } },
      select: claimDisputePublicSelect,
    });
    if (!current) {
      throw new AppError(404, "CLAIM_DISPUTE_NOT_FOUND", "Claim dispute was not found.");
    }
    const change = disputeReviewUpdate(current, action, req.auth.userId, reviewNotes);
    if (change.claimData) {
      const claimUpdate = await tx.claim.updateMany({
        where: {
          claimId: current.claimId,
          claimStatus: change.claimExpectedStatus ?? "VERIFIED",
        },
        data: change.claimData,
      });
      if (claimUpdate.count !== 1) {
        throw new AppError(409, "CLAIM_DISPUTE_CONCURRENT_CHANGE", "The claim changed during review. Reload the case.");
      }
      await tx.auditLog.create({
        data: {
          userId: req.auth.userId,
          action: "CLAIM_VOIDED_AFTER_DISPUTE",
          entityAffected: "CLAIM",
          recordId: current.claimId,
          ipAddress: clientIpAddress(req),
          details: {
            disputeId,
            distributionId,
            referenceNo: current.referenceNo,
            releaseMethod: current.claim.releaseMethod,
            walletReversalRequired: current.claim.releaseMethod !== "PHYSICAL_GOODS"
              && current.claim.distribution?.deliveryMode !== "PHYSICAL_GOODS",
          },
        },
      });
    }
    const disputeUpdate = await tx.claimDispute.updateMany({
      where: {
        disputeId,
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
