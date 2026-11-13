import { z } from "zod";
import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { requireIdempotencyKey, idempotencyRequestHash, findIdempotencyRecord, assertIdempotencyRequestMatches, saveIdempotencyRecord } from "../../utils/idempotency.js";
import { assertBiometricVerifyAllowed } from "../biometrics/biometric.policy.js";
import { publishClaimSignatureResult } from "../../realtime/publishers.js";
import { assertManualVerificationAllowed } from "./manualVerification.service.js";
import { getDistributionClaimParentOrThrow, assertDistributionOpenForClaims, claimMutationSelect, claimMutationToResponse } from "./distributionClaim.service.js";

export const manualVerificationSchema = z.object({
  beneficiaryId: z.uuid(),
  evidenceReference: z.string().trim().min(3).max(120),
  notes: z.string().trim().min(20).max(1000),
  confirmed: z.literal(true),
}).strict();

export const verifyManualClaim = asyncHandler(async (req, res) => {
  assertBiometricVerifyAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const event = await getDistributionClaimParentOrThrow(distributionId, req.staffUser);
  assertDistributionOpenForClaims(event);
  assertManualVerificationAllowed(event);
  const evidence = req.validatedBody;
  const identity = { userId: req.auth.userId, operation: `MANUAL_IDENTITY_VERIFY:${distributionId}`, idempotencyKey: requireIdempotencyKey(req, "manual identity verification") };
  const requestHash = idempotencyRequestHash({ distributionId, ...evidence });
  const replay = await findIdempotencyRecord(identity);
  if (replay) {
    assertIdempotencyRequestMatches(replay, requestHash);
    res.set("Idempotency-Replayed", "true");
    return res.status(replay.responseStatus).json(replay.responseBody);
  }
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const recorded = await findIdempotencyRecord(identity, tx);
      if (recorded) {
        assertIdempotencyRequestMatches(recorded, requestHash);
        return { replayed: true, responseStatus: recorded.responseStatus, responseBody: recorded.responseBody };
      }
      const current = await getDistributionClaimParentOrThrow(distributionId, req.staffUser, tx);
      assertDistributionOpenForClaims(current);
      assertManualVerificationAllowed(current);
      const { beneficiaryId } = evidence;
      const schedule = await tx.schedule.findUnique({ where: { distributionId_beneficiaryId: { distributionId, beneficiaryId } }, select: {
        scheduleId: true, status: true, beneficiary: { select: { status: true, barangayId: true } }, slot: { select: { slotEnd: true } },
      } });
      const allocation = await tx.distributionAllocation.findUnique({ where: { distributionId_beneficiaryId: { distributionId, beneficiaryId } }, select: { allocationId: true, allocationStatus: true, enrollment: { select: { status: true } } } });
      const profile = await tx.biometricData.findUnique({ where: { beneficiaryId }, select: { dataStatus: true } });
      if (["PENDING_DUPLICATE_REVIEW", "DUPLICATE_BLOCKED"].includes(profile?.dataStatus)) throw new AppError(409, "BIOMETRIC_DUPLICATE_REVIEW_REQUIRED", "Authorized duplicate-profile review must be resolved before manual verification.");
      const existing = await tx.claim.findUnique({ where: { beneficiaryId_distributionId: { beneficiaryId, distributionId } }, select: { claimId: true } });
      if (existing) throw new AppError(409, "DUPLICATE_CLAIM", "A claim already exists. Continue its required checks; manual verification cannot replace an existing claim.");
      if (schedule?.status !== "SCHEDULED" || allocation?.allocationStatus !== "ALLOCATED" || allocation.enrollment.status !== "APPROVED" || schedule.beneficiary.status !== "ACTIVE"
          || schedule.beneficiary.barangayId !== current.barangayId || schedule.slot.slotEnd <= new Date()) {
        throw new AppError(409, "MANUAL_CLAIM_NOT_READY", "An active beneficiary, allocation and unexpired scheduled appointment in this event are required.");
      }
      const manualVerification = { basis: current.manualVerificationBasis, evidenceReference: evidence.evidenceReference, notes: evidence.notes,
        verifiedById: req.auth.userId, verifiedByName: req.staffUser.fullName, verifiedAt: new Date().toISOString(), confirmed: true };
      const claim = await tx.claim.create({ data: {
        distributionId, beneficiaryId, scheduleId: schedule.scheduleId, allocationId: allocation.allocationId,
        verificationMethod: "MANUAL", manualVerification, verifiedById: req.auth.userId, claimStatus: "PENDING",
      }, select: claimMutationSelect });
      const update = await tx.schedule.updateMany({ where: { scheduleId: schedule.scheduleId, status: "SCHEDULED" }, data: { status: "CHECKED_IN" } });
      if (update.count !== 1) throw new AppError(409, "MANUAL_VERIFICATION_CONCURRENT_CHANGE", "Appointment changed. Refresh before continuing.");
      await tx.auditLog.create({ data: { userId: req.auth.userId, action: "CLAIM_MANUALLY_REVIEWED_AWAITING_ACKNOWLEDGMENT", entityAffected: "CLAIM", recordId: claim.claimId,
        ipAddress: clientIpAddress(req), details: { distributionId, beneficiaryId, ...manualVerification, assistanceReleased: false } } });
      const responseBody = { success: true, data: { claim: claimMutationToResponse(claim), verificationComplete: false, nextRequiredVerification: "SIGNATURE" } };
      await saveIdempotencyRecord({ identity, requestHash, responseStatus: 201, responseBody }, tx);
      return { replayed: false, responseStatus: 201, responseBody };
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (!["P2002", "P2034"].includes(error.code)) throw error;
    const saved = await findIdempotencyRecord(identity);
    if (!saved) throw new AppError(409, "MANUAL_VERIFICATION_CONCURRENT_CHANGE", "Another request changed the claim. Refresh its saved status before retrying.");
    assertIdempotencyRequestMatches(saved, requestHash);
    result = { replayed: true, responseStatus: saved.responseStatus, responseBody: saved.responseBody };
  }
  res.set("Idempotency-Replayed", String(result.replayed));
  await publishClaimSignatureResult(distributionId, result);
  return res.status(result.responseStatus).json(result.responseBody);
});
