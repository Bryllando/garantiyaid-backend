import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { prepareAssistantApproval } from "../../utils/assistantApproval.js";
import { assertIdempotencyRequestMatches, findIdempotencyRecord, idempotencyRequestHash, requireIdempotencyKey, saveIdempotencyRecord } from "../../utils/idempotency.js";
import { publishScheduleUpdated } from "../../realtime/publishers.js";
import { assertDistributionScheduleManageAllowed } from "./distribution.policy.js";
import { assertDistributionSchedulesManageable, getDistributionScheduleParentOrThrow, schedulableAllocationSelect } from "./distributionSchedule.service.js";
import { distributionSlotCoversBeneficiary, distributionSlotSelect, distributionSlotToResponse } from "./distributionSlot.service.js";
import { buildAiScheduleProblem, scheduleDraftSlots, suggestAiSchedule, validateDraftAssignments } from "./distributionScheduleAi.service.js";

const draftOperation = id => `AI_SCHEDULE_DRAFT:${id}`;

export async function scheduleDraftContext(database, distributionId, staffUser, now = new Date()) {
  const distribution = await getDistributionScheduleParentOrThrow(distributionId, staffUser, database);
  assertDistributionSchedulesManageable(distribution);
  const [allocations, slots, schedules] = await Promise.all([
    database.distributionAllocation.findMany({ where: { distributionId, allocationStatus: "ALLOCATED", beneficiary: { schedules: { none: { distributionId } } } }, select: schedulableAllocationSelect, orderBy: { allocationId: "asc" } }),
    database.distributionSlot.findMany({ where: { distributionId }, select: distributionSlotSelect, orderBy: [{ slotStart: "asc" }, { slotId: "asc" }] }),
    database.schedule.findMany({ where: { distributionId }, select: { scheduleId: true, beneficiaryId: true, slotId: true, queueNumber: true, status: true }, orderBy: { scheduleId: "asc" } }),
  ]);
  const sourceHash = idempotencyRequestHash({ distribution, slots, schedules, allocations: allocations.map(row => ({ allocationId: row.allocationId, beneficiaryId: row.beneficiaryId, status: row.beneficiary.status, sitioPurok: row.beneficiary.sitioPurok })) });
  return { distribution, allocations, slots: scheduleDraftSlots(slots, schedules, now), schedules, sourceHash };
}

export const previewAiDistributionSchedule = asyncHandler(async (req, res) => {
  assertDistributionScheduleManageAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const context = await prisma.$transaction(tx => scheduleDraftContext(tx, distributionId, req.staffUser), { isolationLevel: "RepeatableRead" });
  const problem = buildAiScheduleProblem(context.allocations, context.slots);
  const suggestion = await suggestAiSchedule(problem);
  const approval = await prepareAssistantApproval(req.auth.userId, draftOperation(distributionId), { distributionId, sourceHash: context.sourceHash }, { sourceHash: context.sourceHash, ...suggestion });
  res.status(200).json({ success: true, data: {
    draftId: approval.approvalId, expiresAt: approval.approvalExpiresAt,
    ...suggestion,
    allocations: context.allocations.map(row => ({ allocationId: row.allocationId, beneficiaryName: [row.beneficiary.firstName, row.beneficiary.middleName, row.beneficiary.lastName].filter(Boolean).join(" "), sitioPurok: row.beneficiary.sitioPurok, eligibleSlotIds: context.slots.filter(slot => distributionSlotCoversBeneficiary(slot, row.beneficiary)).map(slot => slot.slotId) })),
    slots: context.slots.map(distributionSlotToResponse),
  } });
});

export const confirmAiDistributionSchedule = asyncHandler(async (req, res) => {
  assertDistributionScheduleManageAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { draftId, assignments } = req.validatedBody;
  if (req.validatedBody.confirmed !== true) throw new AppError(400, "AI_SCHEDULE_CONFIRMATION_REQUIRED", "Review and confirm the draft before saving appointments.");
  const identity = { userId: req.auth.userId, operation: `AI_SCHEDULE_SAVE:${distributionId}`, idempotencyKey: requireIdempotencyKey(req, "AI schedule confirmation") };
  const requestHash = idempotencyRequestHash({ draftId, assignments });
  let result;
  try {
    result = await prisma.$transaction(async tx => {
      await getDistributionScheduleParentOrThrow(distributionId, req.staffUser, tx);
      const previous = await findIdempotencyRecord(identity, tx);
      if (previous) {
        assertIdempotencyRequestMatches(previous, requestHash);
        return { responseStatus: previous.responseStatus, responseBody: previous.responseBody, replayed: true };
      }
      const draft = await findIdempotencyRecord({ userId: req.auth.userId, operation: draftOperation(distributionId), idempotencyKey: draftId }, tx);
      if (!draft || new Date(draft.responseBody.approvalExpiresAt) <= new Date()) throw new AppError(409, "AI_SCHEDULE_DRAFT_EXPIRED", "This AI draft is unavailable or expired. Generate a new draft before saving.");
      const context = await scheduleDraftContext(tx, distributionId, req.staffUser);
      const preview = draft.responseBody.preview;
      if (preview.sourceHash !== context.sourceHash) throw new AppError(409, "AI_SCHEDULE_DRAFT_STALE", "Sessions, capacity or beneficiary assignments changed after this draft was generated. Generate a new draft before saving.");
      validateDraftAssignments(assignments, context.allocations, context.slots);
      const nextQueue = new Map(context.slots.map(slot => [slot.slotId, Math.max(0, ...context.schedules.filter(row => row.slotId === slot.slotId).map(row => row.queueNumber))]));
      const rows = assignments.map(assignment => {
        const allocation = context.allocations.find(row => row.allocationId === assignment.allocationId);
        const queueNumber = nextQueue.get(assignment.slotId) + 1;
        nextQueue.set(assignment.slotId, queueNumber);
        return { scheduleId: randomUUID(), distributionId, beneficiaryId: allocation.beneficiaryId, slotId: assignment.slotId, queueNumber, status: "SCHEDULED", assignedByAi: preview.assignments.some(row => row.allocationId === assignment.allocationId && row.slotId === assignment.slotId) };
      });
      await tx.schedule.createMany({ data: rows });
      for (const slot of context.slots) {
        if (slot.occupied + rows.filter(row => row.slotId === slot.slotId).length === slot.capacity) await tx.distributionSlot.updateMany({ where: { distributionId, slotId: slot.slotId, slotStatus: "AVAILABLE" }, data: { slotStatus: "FULL" } });
      }
      await tx.auditLog.createMany({ data: rows.map(row => ({ userId: req.auth.userId, action: "DISTRIBUTION_AI_SCHEDULE_CONFIRMED", entityAffected: "SCHEDULE", recordId: row.scheduleId, ipAddress: clientIpAddress(req), details: { distributionId, draftId, slotId: row.slotId, queueNumber: row.queueNumber, model: preview.model, assignmentSource: row.assignedByAi ? "AI_SUGGESTED" : "STAFF_EDITED_AI_DRAFT" } })) });
      const responseBody = { success: true, data: { generatedScheduleCount: rows.length, assignedSlotCount: new Set(rows.map(row => row.slotId)).size, draftId } };
      await saveIdempotencyRecord({ identity, requestHash, responseStatus: 201, responseBody }, tx);
      return { responseStatus: 201, responseBody, replayed: false };
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (["P2034", "P2002"].includes(error.code)) throw new AppError(409, "AI_SCHEDULE_CONCURRENT_CHANGE", "Another request changed the schedule. Retry the same confirmation to retrieve its result, or regenerate if the event changed.");
    throw error;
  }
  if (!result.replayed) await publishScheduleUpdated(distributionId, "AI_DRAFT_CONFIRMED");
  res.set("Idempotency-Replayed", String(result.replayed));
  res.status(result.responseStatus).json(result.responseBody);
});
