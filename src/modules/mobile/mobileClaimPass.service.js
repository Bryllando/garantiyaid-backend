import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { hashQrToken, assertQrVerificationConfigured, qrClaimPreviewOutcome } from "../distributions/distributionClaim.service.js";
import { getMobileOverview } from "./mobileOverview.service.js";
import { hashMobileSecret, lockMobileSession } from "./mobile.service.js";

// A domain-separated HMAC lets the owner reopen a mobile-issued credential;
// only its SHA-256 hash is stored, using the existing staff scanner's format.
function mobileQrCredential(qrTokenId) {
  return `gya1_${Buffer.from(hashMobileSecret(`qr-claim-pass:v1:${qrTokenId}`), "hex").toString("base64url")}`;
}

export async function issueMobileClaimPass(session) {
  try {
    return await prisma.$transaction(async (tx) => {
      const account = await lockMobileSession(tx, session);
      if (!account.beneficiaryId || account.link.identityStatus !== "APPROVED")
        throw new AppError(403, "IDENTITY_APPROVAL_REQUIRED", "Admin identity approval is required for a claim pass.");
      const { nextSchedule: schedule } = await getMobileOverview(session, tx);
      if (!schedule) throw new AppError(404, "CLAIM_PASS_UNAVAILABLE", "No eligible published schedule is assigned to your account.");
      const beneficiaryId = account.beneficiaryId;
      const distributionId = schedule.distributionId;
      const distribution = await tx.distribution.findUniqueOrThrow({
        where: { distributionId }, select: { verificationRequirement: true },
      });
      assertQrVerificationConfigured(distribution);
      const claim = await tx.claim.findUnique({
        where: { beneficiaryId_distributionId: { beneficiaryId, distributionId } },
        select: { claimId: true, claimStatus: true, biometricVerified: true, qrVerified: true },
      });
      let qrToken = await tx.qrToken.findUnique({
        where: { beneficiaryId_distributionId: { beneficiaryId, distributionId } },
      });
      if (!qrToken) {
        const qrTokenId = randomUUID();
        qrToken = await tx.qrToken.create({ data: {
          qrTokenId, beneficiaryId, distributionId,
          tokenHash: hashQrToken(mobileQrCredential(qrTokenId)), expiresAt: new Date(schedule.slotEnd),
        } });
        await tx.auditLog.create({ data: {
          actorType: "BENEFICIARY", action: "MOBILE_QR_PASS_ISSUED", entityAffected: "QR_TOKEN", recordId: qrTokenId,
          details: { source: "MOBILE_APP", beneficiaryId, distributionId },
        } });
      }
      const outcome = qrClaimPreviewOutcome({
        distribution, qrToken, schedule: { status: schedule.status.toUpperCase() },
        allocation: { allocationStatus: "ALLOCATED" }, existingClaim: claim,
      });
      if (!outcome.ok) {
        const code = ({ QR_TOKEN_REVOKED: "CLAIM_PASS_REVOKED", QR_TOKEN_EXPIRED: "CLAIM_PASS_EXPIRED" })[outcome.code]
          ?? "CLAIM_PASS_PROCESSED";
        throw new AppError(outcome.statusCode, code, outcome.message);
      }
      const claimCode = mobileQrCredential(qrToken.qrTokenId);
      if (hashQrToken(claimCode) !== qrToken.tokenHash) {
        throw new AppError(409, "CLAIM_PASS_STAFF_ISSUED", "Staff issued this credential separately. Ask them for your pass; the mobile app cannot replace it.");
      }
      const { id, date, slotStart, slotEnd, queueNumber, location, program } = schedule;
      return {
        id: qrToken.qrTokenId, claimCode, status: "active",
        issuedAt: qrToken.createdAt.toISOString(), expiresAt: qrToken.expiresAt.toISOString(),
        schedule: { id, distributionId, date, slotStart, slotEnd, queueNumber, location,
          program: { id: program.id, code: program.code, name: program.name } },
      };
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (["P2034", "P2002"].includes(error.code)) {
      throw new AppError(409, "QR_CLAIM_CONCURRENT_CHANGE", "QR or claim data changed concurrently. Refresh and try again.");
    }
    throw error;
  }
}
