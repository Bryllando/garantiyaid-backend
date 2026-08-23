import { createHash } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { distributionAccessWhere } from "./distribution.policy.js";
import { distributionSlotToResponse } from "./distributionSlot.service.js";

export const OCCUPYING_SCHEDULE_STATUSES = Object.freeze([
  "SCHEDULED",
  "CHECKED_IN",
  "MISSED",
]);

export const scheduleBeneficiarySelect = {
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

export const scheduleSlotSelect = {
  slotId: true,
  distributionId: true,
  slotStart: true,
  slotEnd: true,
  capacity: true,
  slotStatus: true,
  createdAt: true,
  updatedAt: true,
};

export const distributionScheduleSelect = {
  scheduleId: true,
  distributionId: true,
  beneficiaryId: true,
  slotId: true,
  queueNumber: true,
  status: true,
  assignedByAi: true,
  notificationAt: true,
  createdAt: true,
  updatedAt: true,
  beneficiary: { select: scheduleBeneficiarySelect },
  slot: { select: scheduleSlotSelect },
};

export const schedulableAllocationSelect = {
  allocationId: true,
  distributionId: true,
  beneficiaryId: true,
  enrollmentId: true,
  amount: true,
  allocationStatus: true,
  allocatedAt: true,
  beneficiary: { select: scheduleBeneficiarySelect },
};

export const distributionScheduleParentSelect = {
  distributionId: true,
  programId: true,
  barangayId: true,
  status: true,
};

export function distributionScheduleToResponse(schedule) {
  return {
    ...schedule,
    ...(schedule.slot ? { slot: distributionSlotToResponse(schedule.slot) } : {}),
  };
}

export function schedulableAllocationToResponse(allocation) {
  return {
    ...allocation,
    amount: allocation.amount.toString(),
  };
}

export function scheduleGenerationRequestHash(allocationIds) {
  const normalized = allocationIds ? [...allocationIds].sort() : "ALL_SCHEDULABLE";
  return createHash("sha256").update(JSON.stringify({ allocationIds: normalized })).digest("hex");
}

export function assertDistributionSchedulesManageable(distribution) {
  if (distribution.status !== "DRAFT") {
    throw new AppError(
      409,
      "DISTRIBUTION_SCHEDULES_NOT_EDITABLE",
      "Schedules can only be managed while the distribution event is in draft status.",
    );
  }
}

export function assertAllocationSchedulable(allocation) {
  if (allocation.allocationStatus !== "ALLOCATED") {
    throw new AppError(
      409,
      "ALLOCATION_NOT_SCHEDULABLE",
      "Only allocated beneficiaries can be scheduled.",
      { allocationId: allocation.allocationId },
    );
  }
}

export function assertSlotAvailable(slot, activeScheduleCount) {
  if (slot.slotStatus !== "AVAILABLE") {
    throw new AppError(
      409,
      "DISTRIBUTION_SLOT_NOT_AVAILABLE",
      "The selected distribution slot is not available.",
      { slotId: slot.slotId, slotStatus: slot.slotStatus },
    );
  }

  if (activeScheduleCount >= slot.capacity) {
    throw new AppError(
      409,
      "DISTRIBUTION_SLOT_CAPACITY_EXCEEDED",
      "The selected distribution slot has reached its capacity.",
      { slotId: slot.slotId, capacity: slot.capacity },
    );
  }
}

export function assertDistributionScheduleTransition(schedule, nextStatus) {
  const allowedTransitions = {
    SCHEDULED: ["CANCELLED"],
    CANCELLED: ["SCHEDULED"],
    CHECKED_IN: [],
    MISSED: [],
  };

  if (!allowedTransitions[schedule.status]?.includes(nextStatus)) {
    throw new AppError(
      409,
      "INVALID_DISTRIBUTION_SCHEDULE_TRANSITION",
      `Distribution schedule cannot transition from ${schedule.status} to ${nextStatus}.`,
    );
  }
}

export function assertDistributionScheduleReschedulable(schedule, targetSlotId) {
  if (schedule.status !== "SCHEDULED") {
    throw new AppError(
      409,
      "DISTRIBUTION_SCHEDULE_NOT_RESCHEDULABLE",
      "Only an active scheduled beneficiary can be rescheduled.",
    );
  }
  if (schedule.slotId === targetSlotId) {
    throw new AppError(
      409,
      "DISTRIBUTION_SCHEDULE_SLOT_UNCHANGED",
      "The target slot must be different from the current slot.",
    );
  }
}

export function buildScheduleSearchWhere(search) {
  if (!search) {
    return {};
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(search);
  const queueNumber = /^\d+$/.test(search) ? Number(search) : null;
  return {
    OR: [
      ...(isUuid ? [
        { scheduleId: search },
        { beneficiaryId: search },
        { slotId: search },
      ] : []),
      ...(Number.isSafeInteger(queueNumber) && queueNumber > 0 ? [{ queueNumber }] : []),
      { beneficiary: { firstName: { contains: search, mode: "insensitive" } } },
      { beneficiary: { middleName: { contains: search, mode: "insensitive" } } },
      { beneficiary: { lastName: { contains: search, mode: "insensitive" } } },
    ],
  };
}

export function buildSchedulableAllocationSearchWhere(search) {
  if (!search) {
    return {};
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(search);
  return {
    OR: [
      ...(isUuid ? [
        { allocationId: search },
        { beneficiaryId: search },
        { enrollmentId: search },
      ] : []),
      { beneficiary: { firstName: { contains: search, mode: "insensitive" } } },
      { beneficiary: { middleName: { contains: search, mode: "insensitive" } } },
      { beneficiary: { lastName: { contains: search, mode: "insensitive" } } },
    ],
  };
}

export async function getDistributionScheduleParentOrThrow(
  distributionId,
  staffUser,
  database = prisma,
) {
  const distribution = await database.distribution.findFirst({
    where: {
      distributionId,
      ...distributionAccessWhere(staffUser),
    },
    select: distributionScheduleParentSelect,
  });

  if (!distribution) {
    throw new AppError(404, "DISTRIBUTION_NOT_FOUND", "Distribution event was not found.");
  }
  return distribution;
}

export async function getSchedulableAllocationOrThrow(
  distributionId,
  allocationId,
  database = prisma,
) {
  const allocation = await database.distributionAllocation.findFirst({
    where: { distributionId, allocationId },
    select: schedulableAllocationSelect,
  });
  if (!allocation) {
    throw new AppError(
      404,
      "DISTRIBUTION_ALLOCATION_NOT_FOUND",
      "Distribution allocation was not found.",
    );
  }
  return allocation;
}

export async function getScheduleSlotOrThrow(distributionId, slotId, database = prisma) {
  const slot = await database.distributionSlot.findFirst({
    where: { distributionId, slotId },
    select: scheduleSlotSelect,
  });
  if (!slot) {
    throw new AppError(404, "DISTRIBUTION_SLOT_NOT_FOUND", "Distribution slot was not found.");
  }
  return slot;
}

export async function getDistributionScheduleOrThrow(
  distributionId,
  scheduleId,
  database = prisma,
) {
  const schedule = await database.schedule.findFirst({
    where: { distributionId, scheduleId },
    select: distributionScheduleSelect,
  });
  if (!schedule) {
    throw new AppError(
      404,
      "DISTRIBUTION_SCHEDULE_NOT_FOUND",
      "Distribution schedule was not found.",
    );
  }
  return schedule;
}

export async function activeScheduleCount(slotId, database = prisma) {
  return database.schedule.count({
    where: { slotId, status: { in: OCCUPYING_SCHEDULE_STATUSES } },
  });
}

export async function nextSlotQueueNumber(slotId, database = prisma) {
  const aggregate = await database.schedule.aggregate({
    where: { slotId },
    _max: { queueNumber: true },
  });
  return (aggregate._max.queueNumber ?? 0) + 1;
}

export async function assertBeneficiaryHasNoSchedule(
  distributionId,
  beneficiaryId,
  database = prisma,
) {
  const schedule = await database.schedule.findUnique({
    where: {
      distributionId_beneficiaryId: { distributionId, beneficiaryId },
    },
    select: { scheduleId: true, status: true },
  });
  if (schedule) {
    throw new AppError(
      409,
      "BENEFICIARY_ALREADY_SCHEDULED",
      "This beneficiary already has a schedule for the distribution event.",
      { scheduleId: schedule.scheduleId, status: schedule.status },
    );
  }
}

export async function distributionOpeningReadiness(distributionId, database = prisma) {
  const allocations = await database.distributionAllocation.findMany({
    where: { distributionId, allocationStatus: "ALLOCATED" },
    select: { allocationId: true, beneficiaryId: true },
    orderBy: { allocationId: "asc" },
  });
  if (allocations.length === 0) {
    throw new AppError(
      409,
      "DISTRIBUTION_NO_ACTIVE_ALLOCATIONS",
      "A distribution event needs at least one active allocation before it can open.",
    );
  }

  const schedules = await database.schedule.findMany({
    where: { distributionId },
    select: {
      scheduleId: true,
      beneficiaryId: true,
      slotId: true,
      status: true,
      slot: { select: { distributionId: true, capacity: true } },
    },
  });
  const activeSchedules = schedules.filter((schedule) => (
    OCCUPYING_SCHEDULE_STATUSES.includes(schedule.status)
  ));
  const activeScheduledBeneficiaries = new Set(
    activeSchedules.map((schedule) => schedule.beneficiaryId),
  );
  const missingAllocations = allocations.filter((allocation) => (
    !activeScheduledBeneficiaries.has(allocation.beneficiaryId)
  ));
  if (missingAllocations.length > 0) {
    throw new AppError(
      409,
      "DISTRIBUTION_ALLOCATIONS_UNSCHEDULED",
      "Every active allocation must have an active schedule before the event can open.",
      {
        unscheduledAllocationCount: missingAllocations.length,
        allocationIds: missingAllocations.slice(0, 20).map((row) => row.allocationId),
      },
    );
  }

  const allocatedBeneficiaries = new Set(allocations.map((allocation) => allocation.beneficiaryId));
  const mismatchedSchedules = activeSchedules.filter((schedule) => (
    !allocatedBeneficiaries.has(schedule.beneficiaryId)
    || schedule.slot.distributionId !== distributionId
  ));
  if (mismatchedSchedules.length > 0) {
    throw new AppError(
      409,
      "DISTRIBUTION_SCHEDULE_INTEGRITY_ERROR",
      "Every active schedule must belong to an active allocation and a slot in this event.",
      { scheduleIds: mismatchedSchedules.slice(0, 20).map((row) => row.scheduleId) },
    );
  }

  const countsBySlot = new Map();
  for (const schedule of activeSchedules) {
    countsBySlot.set(schedule.slotId, (countsBySlot.get(schedule.slotId) ?? 0) + 1);
  }
  const overCapacitySlotIds = [...countsBySlot.entries()]
    .filter(([slotId, count]) => {
      const schedule = activeSchedules.find((row) => row.slotId === slotId);
      return count > schedule.slot.capacity;
    })
    .map(([slotId]) => slotId);
  if (overCapacitySlotIds.length > 0) {
    throw new AppError(
      409,
      "DISTRIBUTION_SLOT_CAPACITY_EXCEEDED",
      "One or more slots exceed capacity, so the event cannot open.",
      { slotIds: overCapacitySlotIds.slice(0, 20) },
    );
  }

  return {
    activeAllocationCount: allocations.length,
    activeScheduleCount: activeSchedules.length,
    slotCount: countsBySlot.size,
  };
}

