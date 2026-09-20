import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import {
  assertIdempotencyRequestMatches,
  findIdempotencyRecord,
  idempotencyRequestHash,
  requireIdempotencyKey,
  saveIdempotencyRecord,
} from "../../utils/idempotency.js";
import { assertPhysicalReleaseAllowed } from "./distribution.policy.js";
import {
  assertPhysicalClaimReleasable,
  claimPublicSelect,
  claimToResponse,
  getDistributionClaimParentOrThrow,
} from "./distributionClaim.service.js";

function releaseResponse(claim) {
  return {
    success: true,
    data: {
      claim: claimToResponse(claim),
      release: {
        method: claim.releaseMethod,
        releasedAt: claim.releasedAt,
        releasedBy: claim.releasedBy,
        evidence: {
          type: claim.releaseEvidenceType,
          reference: claim.releaseEvidenceReference,
          notes: claim.releaseNotes,
        },
      },
      lifecycle: {
        claimId: claim.claimId,
        claimStatus: claim.claimStatus,
        allocationId: claim.allocationId,
        allocationStatus: claim.allocation.allocationStatus,
      },
    },
  };
}

async function replayIfRecorded(identity, requestHash) {
  const record = await findIdempotencyRecord(identity);
  if (!record) return null;
  assertIdempotencyRequestMatches(record, requestHash);
  return {
    replayed: true,
    responseStatus: record.responseStatus,
    responseBody: record.responseBody,
  };
}

export const markPhysicalClaimReleased = asyncHandler(async (req, res) => {
  assertPhysicalReleaseAllowed(req.staffUser);
  const { distributionId, claimId } = req.validatedParams;
  const evidence = req.validatedBody;
  const distribution = await getDistributionClaimParentOrThrow(
    distributionId,
    req.staffUser,
  );
  if (distribution.deliveryMode !== "PHYSICAL_GOODS") {
    throw new AppError(
      409,
      "DISTRIBUTION_NOT_PHYSICAL_GOODS",
      "This distribution uses simulated wallet settlement, not physical release.",
    );
  }

  const idempotencyKey = requireIdempotencyKey(req, "physical assistance release");
  const identity = {
    userId: req.auth.userId,
    operation: `PHYSICAL_ASSISTANCE_RELEASE:${distributionId}:${claimId}`,
    idempotencyKey,
  };
  const requestHash = idempotencyRequestHash({ distributionId, claimId, ...evidence });
  const replay = await replayIfRecorded(identity, requestHash);
  if (replay) {
    res.set("Idempotency-Replayed", "true");
    return res.status(replay.responseStatus).json(replay.responseBody);
  }

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const concurrentRecord = await tx.idempotencyRecord.findUnique({
        where: { userId_operation_idempotencyKey: identity },
      });
      if (concurrentRecord) {
        assertIdempotencyRequestMatches(concurrentRecord, requestHash);
        return {
          replayed: true,
          responseStatus: concurrentRecord.responseStatus,
          responseBody: concurrentRecord.responseBody,
        };
      }

      const currentDistribution = await getDistributionClaimParentOrThrow(
        distributionId,
        req.staffUser,
        tx,
      );
      const claim = await tx.claim.findFirst({
        where: { claimId, distributionId },
        select: claimPublicSelect,
      });
      if (!claim) {
        throw new AppError(404, "CLAIM_NOT_FOUND", "Claim verification record was not found.");
      }
      assertPhysicalClaimReleasable(claim, currentDistribution);

      const now = new Date();
      const claimUpdate = await tx.claim.updateMany({
        where: {
          claimId,
          distributionId,
          claimStatus: "VERIFIED",
          releasedAt: null,
        },
        data: {
          claimStatus: "CLAIMED",
          releaseMethod: "PHYSICAL_GOODS",
          releasedById: req.auth.userId,
          releasedAt: now,
          releaseEvidenceType: evidence.evidenceType,
          releaseEvidenceReference: evidence.evidenceReference,
          releaseNotes: evidence.notes ?? null,
          claimedAt: now,
        },
      });
      const allocationUpdate = await tx.distributionAllocation.updateMany({
        where: {
          allocationId: claim.allocationId,
          distributionId,
          allocationStatus: "ALLOCATED",
        },
        data: { allocationStatus: "CLAIMED" },
      });
      if (claimUpdate.count !== 1 || allocationUpdate.count !== 1) {
        throw new AppError(
          409,
          "PHYSICAL_RELEASE_CONCURRENT_CHANGE",
          "The claim or allocation changed while release was being recorded. Reload the claim before trying again.",
        );
      }

      const releasedClaim = await tx.claim.findUniqueOrThrow({
        where: { claimId },
        select: claimPublicSelect,
      });
      await tx.auditLog.create({
        data: {
          userId: req.auth.userId,
          action: "PHYSICAL_ASSISTANCE_RELEASED",
          entityAffected: "CLAIM",
          recordId: claimId,
          ipAddress: clientIpAddress(req),
          details: {
            distributionId,
            beneficiaryId: releasedClaim.beneficiaryId,
            allocationId: releasedClaim.allocationId,
            releaseMethod: "PHYSICAL_GOODS",
            evidenceType: evidence.evidenceType,
            evidenceReference: evidence.evidenceReference,
            beneficiaryAcknowledged: true,
            releasedAt: now.toISOString(),
            claimStatus: "CLAIMED",
            allocationStatus: "CLAIMED",
          },
        },
      });

      const responseBody = releaseResponse(releasedClaim);
      await saveIdempotencyRecord({
        identity,
        requestHash,
        responseStatus: 201,
        responseBody,
        now,
      }, tx);
      return { replayed: false, responseStatus: 201, responseBody };
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (["P2002", "P2034"].includes(error.code)) {
      const completed = await replayIfRecorded(identity, requestHash);
      if (completed) result = completed;
      else {
        throw new AppError(
          409,
          "PHYSICAL_RELEASE_CONCURRENT_CHANGE",
          "Another release request changed this claim. Reload it before trying again.",
        );
      }
    } else {
      throw error;
    }
  }

  res.set("Idempotency-Replayed", String(result.replayed));
  return res.status(result.responseStatus).json(result.responseBody);
});
