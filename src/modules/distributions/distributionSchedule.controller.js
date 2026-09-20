import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { publishDistributionUpdated } from "../../realtime/publishers.js";
import {
  assertDistributionManageAllowed,
  assertDistributionReadAllowed,
  assertDistributionScheduleManageAllowed,
} from "./distribution.policy.js";
import { idempotencyKeySchema } from "./distributionAllocation.schemas.js";
import { distributionSelect, distributionToResponse } from "./distribution.service.js";
import {
  assertDistributionSlotCoverage,
  distributionSlotCoversBeneficiary,
} from "./distributionSlot.service.js";
import {
  OCCUPYING_SCHEDULE_STATUSES,
  activeScheduleCount,
  assertAllocationSchedulable,
  assertBeneficiaryHasNoSchedule,
  assertDistributionScheduleReschedulable,
  assertDistributionSchedulesManageable,
  assertDistributionScheduleTransition,
  assertSlotAvailable,
  buildSchedulableAllocationSearchWhere,
  buildScheduleSearchWhere,
  distributionOpeningReadiness,
  distributionScheduleSelect,
  distributionScheduleToResponse,
  getDistributionScheduleOrThrow,
  getDistributionScheduleParentOrThrow,
  getSchedulableAllocationOrThrow,
  getScheduleSlotOrThrow,
  nextSlotQueueNumber,
  schedulableAllocationSelect,
  schedulableAllocationToResponse,
  scheduleGenerationRequestHash,
} from "./distributionSchedule.service.js";

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function scheduleIdempotencyKey(req) {
  const rawKey = req.get("idempotency-key");
  if (!rawKey) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "An Idempotency-Key UUID header is required when generating schedules.",
    );
  }
  const result = idempotencyKeySchema.safeParse(rawKey.trim());
  if (!result.success) {
    throw new AppError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be a valid UUID.",
    );
  }
  return result.data;
}

function assertMatchingIdempotencyRequest(record, requestHash) {
  if (record.requestHash !== requestHash) {
    throw new AppError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used with a different schedule-generation request.",
    );
  }
}

async function findUsableIdempotencyRecord({ userId, operation, idempotencyKey }) {
  const record = await prisma.idempotencyRecord.findUnique({
    where: {
      userId_operation_idempotencyKey: { userId, operation, idempotencyKey },
    },
  });
  if (!record) {
    return null;
  }
  if (record.expiresAt > new Date()) {
    return record;
  }
  await prisma.idempotencyRecord.deleteMany({
    where: {
      idempotencyRecordId: record.idempotencyRecordId,
      expiresAt: { lte: new Date() },
    },
  });
  return null;
}

async function runScheduleTransaction(operation) {
  try {
    return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error.code === "P2034") {
      throw new AppError(
        409,
        "DISTRIBUTION_SCHEDULE_CONCURRENT_CHANGE",
        "Distribution schedule data changed concurrently. Refresh and try again.",
      );
    }
    throw error;
  }
}

async function markSlotFullIfNeeded(database, slot, activeCountAfter) {
  if (activeCountAfter < slot.capacity) {
    return;
  }
  await database.distributionSlot.updateMany({
    where: {
      slotId: slot.slotId,
      distributionId: slot.distributionId,
      slotStatus: "AVAILABLE",
    },
    data: { slotStatus: "FULL" },
  });
}

async function releaseFullSlot(database, slotId, distributionId) {
  await database.distributionSlot.updateMany({
    where: { slotId, distributionId, slotStatus: "FULL" },
    data: { slotStatus: "AVAILABLE" },
  });
}

async function createScheduleAudit(database, req, schedule, action, details = {}) {
  await database.auditLog.create({
    data: {
      userId: req.auth.userId,
      action,
      entityAffected: "SCHEDULE",
      recordId: schedule.scheduleId,
      ipAddress: clientIpAddress(req),
      details: {
        distributionId: schedule.distributionId,
        beneficiaryId: schedule.beneficiaryId,
        slotId: schedule.slotId,
        queueNumber: schedule.queueNumber,
        ...details,
      },
    },
  });
}

export const listSchedulableAllocations = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { page, pageSize, search } = req.validatedQuery;
  await getDistributionScheduleParentOrThrow(distributionId, req.staffUser);

  const where = {
    distributionId,
    allocationStatus: "ALLOCATED",
    beneficiary: { schedules: { none: { distributionId } } },
    ...buildSchedulableAllocationSearchWhere(search),
  };
  const [allocations, total] = await Promise.all([
    prisma.distributionAllocation.findMany({
      where,
      select: schedulableAllocationSelect,
      orderBy: [
        { beneficiary: { lastName: "asc" } },
        { beneficiary: { firstName: "asc" } },
        { allocationId: "asc" },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.distributionAllocation.count({ where }),
  ]);

  return res.status(200).json({
    success: true,
    data: {
      allocations: allocations.map(schedulableAllocationToResponse),
      summary: { schedulableAllocationCount: total },
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    },
  });
});

export const createDistributionSchedule = asyncHandler(async (req, res) => {
  assertDistributionScheduleManageAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { allocationId, slotId } = req.validatedBody;

  let scheduleId;
  try {
    scheduleId = await runScheduleTransaction(async (tx) => {
      const distribution = await getDistributionScheduleParentOrThrow(
        distributionId,
        req.staffUser,
        tx,
      );
      assertDistributionSchedulesManageable(distribution);
      const allocation = await getSchedulableAllocationOrThrow(
        distributionId,
        allocationId,
        tx,
      );
      assertAllocationSchedulable(allocation);
      await assertBeneficiaryHasNoSchedule(distributionId, allocation.beneficiaryId, tx);

      const slot = await getScheduleSlotOrThrow(distributionId, slotId, tx);
      assertDistributionSlotCoverage(slot, allocation.beneficiary);
      const occupyingCount = await activeScheduleCount(slotId, tx);
      assertSlotAvailable(slot, occupyingCount);
      const queueNumber = await nextSlotQueueNumber(slotId, tx);
      const schedule = await tx.schedule.create({
        data: {
          distributionId,
          beneficiaryId: allocation.beneficiaryId,
          slotId,
          queueNumber,
          status: "SCHEDULED",
          assignedByAi: false,
        },
        select: {
          scheduleId: true,
          distributionId: true,
          beneficiaryId: true,
          slotId: true,
          queueNumber: true,
        },
      });
      await markSlotFullIfNeeded(tx, slot, occupyingCount + 1);
      await createScheduleAudit(tx, req, schedule, "DISTRIBUTION_SCHEDULE_CREATED", {
        allocationId,
        assignedAutomatically: false,
        status: "SCHEDULED",
      });
      return schedule.scheduleId;
    });
  } catch (error) {
    if (error.code === "P2002") {
      throw new AppError(
        409,
        "DISTRIBUTION_SCHEDULE_CONCURRENT_CHANGE",
        "The beneficiary or queue number was scheduled concurrently. Refresh and try again.",
      );
    }
    throw error;
  }

  const schedule = await getDistributionScheduleOrThrow(distributionId, scheduleId);
  return res.status(201).json({
    success: true,
    data: { schedule: distributionScheduleToResponse(schedule) },
  });
});

async function generationAllocations(transaction, distributionId, allocationIds) {
  if (!allocationIds) {
    return transaction.distributionAllocation.findMany({
      where: {
        distributionId,
        allocationStatus: "ALLOCATED",
        beneficiary: { schedules: { none: { distributionId } } },
      },
      select: schedulableAllocationSelect,
      orderBy: [
        { beneficiary: { lastName: "asc" } },
        { beneficiary: { firstName: "asc" } },
        { allocationId: "asc" },
      ],
    });
  }

  const allocations = await transaction.distributionAllocation.findMany({
    where: { distributionId, allocationId: { in: allocationIds } },
    select: schedulableAllocationSelect,
    orderBy: [
      { beneficiary: { lastName: "asc" } },
      { beneficiary: { firstName: "asc" } },
      { allocationId: "asc" },
    ],
  });
  if (allocations.length !== allocationIds.length) {
    throw new AppError(
      409,
      "ALLOCATION_NOT_SCHEDULABLE",
      "Every requested allocation must belong to this distribution event and be schedulable.",
    );
  }
  for (const allocation of allocations) {
    assertAllocationSchedulable(allocation);
    await assertBeneficiaryHasNoSchedule(
      distributionId,
      allocation.beneficiaryId,
      transaction,
    );
  }
  return allocations;
}

export const generateDistributionSchedules = asyncHandler(async (req, res) => {
  assertDistributionScheduleManageAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { allocationIds } = req.validatedBody;
  const idempotencyKey = scheduleIdempotencyKey(req);
  const operation = `DISTRIBUTION_SCHEDULE_BATCH:${distributionId}`;
  const requestHash = scheduleGenerationRequestHash(allocationIds);
  const idempotencyIdentity = {
    userId: req.auth.userId,
    operation,
    idempotencyKey,
  };

  await prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  const existingRecord = await findUsableIdempotencyRecord(idempotencyIdentity);
  if (existingRecord) {
    assertMatchingIdempotencyRequest(existingRecord, requestHash);
    res.set("Idempotency-Replayed", "true");
    return res.status(existingRecord.responseStatus).json(existingRecord.responseBody);
  }

  let result;
  try {
    result = await runScheduleTransaction(async (tx) => {
      const transactionRecord = await tx.idempotencyRecord.findUnique({
        where: { userId_operation_idempotencyKey: idempotencyIdentity },
      });
      if (transactionRecord && transactionRecord.expiresAt > new Date()) {
        assertMatchingIdempotencyRequest(transactionRecord, requestHash);
        return {
          replayed: true,
          responseStatus: transactionRecord.responseStatus,
          responseBody: transactionRecord.responseBody,
        };
      }

      const distribution = await getDistributionScheduleParentOrThrow(
        distributionId,
        req.staffUser,
        tx,
      );
      assertDistributionSchedulesManageable(distribution);
      const allocations = await generationAllocations(tx, distributionId, allocationIds);
      if (allocations.length === 0) {
        throw new AppError(
          409,
          "NO_SCHEDULABLE_ALLOCATIONS",
          "There are no unscheduled active allocations for this distribution event.",
        );
      }

      const slots = await tx.distributionSlot.findMany({
        where: { distributionId, slotStatus: "AVAILABLE" },
        select: {
          slotId: true,
          distributionId: true,
          sessionId: true,
          sessionLabel: true,
          location: true,
          serviceAreas: true,
          slotStart: true,
          capacity: true,
          slotStatus: true,
          schedules: { select: { queueNumber: true, status: true } },
        },
        orderBy: [{ slotStart: "asc" }, { slotId: "asc" }],
      });
      const slotStates = slots.map((slot) => {
        const occupyingCount = slot.schedules.filter((schedule) => (
          OCCUPYING_SCHEDULE_STATUSES.includes(schedule.status)
        )).length;
        const maxQueueNumber = slot.schedules.reduce(
          (maximum, schedule) => Math.max(maximum, schedule.queueNumber),
          0,
        );
        return {
          ...slot,
          occupyingCount,
          nextQueueNumber: maxQueueNumber + 1,
          remainingCapacity: Math.max(0, slot.capacity - occupyingCount),
        };
      });
      const totalAvailableCapacity = slotStates.reduce(
        (total, slot) => total + slot.remainingCapacity,
        0,
      );
      if (totalAvailableCapacity < allocations.length) {
        throw new AppError(
          409,
          "INSUFFICIENT_DISTRIBUTION_SLOT_CAPACITY",
          "Available distribution slots cannot accommodate every requested allocation.",
          {
            requestedScheduleCount: allocations.length,
            availableCapacity: totalAvailableCapacity,
            shortfall: allocations.length - totalAvailableCapacity,
          },
        );
      }

      const now = new Date();
      const rows = [];
      for (const allocation of allocations) {
        // ponytail: linear scan is bounded by the current batch limit; index by area if it grows.
        const slot = slotStates.find((candidate) => (
          candidate.remainingCapacity > 0
          && distributionSlotCoversBeneficiary(candidate, allocation.beneficiary)
        ));
        if (!slot) {
          throw new AppError(
            409,
            "INSUFFICIENT_DISTRIBUTION_SERVICE_AREA_CAPACITY",
            "Available sessions cannot accommodate every beneficiary in their Sitio or Purok.",
            {
              beneficiaryId: allocation.beneficiaryId,
              sitioPurok: allocation.beneficiary.sitioPurok ?? null,
            },
          );
        }
        rows.push({
          scheduleId: randomUUID(),
          distributionId,
          beneficiaryId: allocation.beneficiaryId,
          slotId: slot.slotId,
          queueNumber: slot.nextQueueNumber,
          status: "SCHEDULED",
          assignedByAi: true,
          createdAt: now,
          updatedAt: now,
          allocationId: allocation.allocationId,
        });
        slot.nextQueueNumber += 1;
        slot.occupyingCount += 1;
        slot.remainingCapacity -= 1;
      }

      await tx.schedule.createMany({
        data: rows.map(({ allocationId: ignoredAllocationId, ...row }) => row),
      });
      for (const slot of slotStates) {
        await markSlotFullIfNeeded(tx, slot, slot.occupyingCount);
      }
      await tx.auditLog.createMany({
        data: rows.map((row) => ({
          userId: req.auth.userId,
          action: "DISTRIBUTION_SCHEDULE_GENERATED",
          entityAffected: "SCHEDULE",
          recordId: row.scheduleId,
          ipAddress: clientIpAddress(req),
          details: {
            distributionId,
            allocationId: row.allocationId,
            beneficiaryId: row.beneficiaryId,
            slotId: row.slotId,
            queueNumber: row.queueNumber,
            assignedAutomatically: true,
            status: row.status,
          },
        })),
      });
      const schedules = await tx.schedule.findMany({
        where: { scheduleId: { in: rows.map((row) => row.scheduleId) } },
        select: distributionScheduleSelect,
        orderBy: [{ slot: { slotStart: "asc" } }, { queueNumber: "asc" }],
      });
      const responseBody = jsonSafe({
        success: true,
        data: {
          schedules: schedules.map(distributionScheduleToResponse),
          summary: {
            generatedScheduleCount: schedules.length,
            assignedSlotCount: new Set(rows.map((row) => row.slotId)).size,
          },
        },
      });
      const responseStatus = 201;
      await tx.idempotencyRecord.create({
        data: {
          ...idempotencyIdentity,
          requestHash,
          responseStatus,
          responseBody,
          expiresAt: new Date(now.getTime() + env.idempotencyTtlHours * 60 * 60 * 1000),
        },
      });
      return { replayed: false, responseStatus, responseBody };
    });
  } catch (error) {
    const mayBeConcurrentRequest = error.code === "P2002"
      || error.code === "DISTRIBUTION_SCHEDULE_CONCURRENT_CHANGE";
    if (!mayBeConcurrentRequest) {
      throw error;
    }
    const concurrentRecord = await findUsableIdempotencyRecord(idempotencyIdentity);
    if (!concurrentRecord) {
      if (error.code === "DISTRIBUTION_SCHEDULE_CONCURRENT_CHANGE") {
        throw error;
      }
      throw new AppError(
        409,
        "DISTRIBUTION_SCHEDULE_CONCURRENT_CHANGE",
        "A beneficiary or queue number was scheduled concurrently. Refresh and try again.",
      );
    }
    assertMatchingIdempotencyRequest(concurrentRecord, requestHash);
    result = {
      replayed: true,
      responseStatus: concurrentRecord.responseStatus,
      responseBody: concurrentRecord.responseBody,
    };
  }

  res.set("Idempotency-Replayed", String(result.replayed));
  return res.status(result.responseStatus).json(result.responseBody);
});

export const listDistributionSchedules = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { page, pageSize, status, slotId, search } = req.validatedQuery;
  await getDistributionScheduleParentOrThrow(distributionId, req.staffUser);

  const matchingWhere = {
    distributionId,
    ...(status ? { status } : {}),
    ...(slotId ? { slotId } : {}),
    ...buildScheduleSearchWhere(search),
  };
  const [schedules, total, statusGroups] = await Promise.all([
    prisma.schedule.findMany({
      where: matchingWhere,
      select: distributionScheduleSelect,
      orderBy: [
        { slot: { slotStart: "asc" } },
        { queueNumber: "asc" },
        { scheduleId: "asc" },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.schedule.count({ where: matchingWhere }),
    prisma.schedule.groupBy({
      by: ["status"],
      where: { distributionId },
      _count: { _all: true },
    }),
  ]);
  const countsByStatus = Object.fromEntries(
    statusGroups.map((group) => [group.status, group._count._all]),
  );

  return res.status(200).json({
    success: true,
    data: {
      schedules: schedules.map(distributionScheduleToResponse),
      summary: { matchingScheduleCount: total, countsByStatus },
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    },
  });
});

export const getDistributionSchedule = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId, scheduleId } = req.validatedParams;
  await getDistributionScheduleParentOrThrow(distributionId, req.staffUser);
  const schedule = await getDistributionScheduleOrThrow(distributionId, scheduleId);
  return res.status(200).json({
    success: true,
    data: { schedule: distributionScheduleToResponse(schedule) },
  });
});

export const rescheduleDistributionSchedule = asyncHandler(async (req, res) => {
  assertDistributionScheduleManageAllowed(req.staffUser);
  const { distributionId, scheduleId } = req.validatedParams;
  const { slotId: targetSlotId } = req.validatedBody;

  await runScheduleTransaction(async (tx) => {
    const distribution = await getDistributionScheduleParentOrThrow(
      distributionId,
      req.staffUser,
      tx,
    );
    assertDistributionSchedulesManageable(distribution);
    const schedule = await getDistributionScheduleOrThrow(distributionId, scheduleId, tx);
    assertDistributionScheduleReschedulable(schedule, targetSlotId);
    const targetSlot = await getScheduleSlotOrThrow(distributionId, targetSlotId, tx);
    assertDistributionSlotCoverage(targetSlot, schedule.beneficiary);
    const targetOccupyingCount = await activeScheduleCount(targetSlotId, tx);
    assertSlotAvailable(targetSlot, targetOccupyingCount);
    const queueNumber = await nextSlotQueueNumber(targetSlotId, tx);

    const update = await tx.schedule.updateMany({
      where: {
        distributionId,
        scheduleId,
        slotId: schedule.slotId,
        queueNumber: schedule.queueNumber,
        status: "SCHEDULED",
      },
      data: { slotId: targetSlotId, queueNumber },
    });
    if (update.count !== 1) {
      throw new AppError(
        409,
        "DISTRIBUTION_SCHEDULE_CONCURRENT_CHANGE",
        "Distribution schedule data changed concurrently. Refresh and try again.",
      );
    }
    await releaseFullSlot(tx, schedule.slotId, distributionId);
    await markSlotFullIfNeeded(tx, targetSlot, targetOccupyingCount + 1);
    await createScheduleAudit(
      tx,
      req,
      { ...schedule, slotId: targetSlotId, queueNumber },
      "DISTRIBUTION_SCHEDULE_RESCHEDULED",
      {
        previousSlotId: schedule.slotId,
        previousQueueNumber: schedule.queueNumber,
        status: schedule.status,
      },
    );
  });

  const schedule = await getDistributionScheduleOrThrow(distributionId, scheduleId);
  return res.status(200).json({
    success: true,
    data: { schedule: distributionScheduleToResponse(schedule) },
  });
});

async function transitionDistributionSchedule(req, nextStatus, action) {
  const { distributionId, scheduleId } = req.validatedParams;
  await runScheduleTransaction(async (tx) => {
    const distribution = await getDistributionScheduleParentOrThrow(
      distributionId,
      req.staffUser,
      tx,
    );
    assertDistributionSchedulesManageable(distribution);
    const schedule = await getDistributionScheduleOrThrow(distributionId, scheduleId, tx);
    assertDistributionScheduleTransition(schedule, nextStatus);

    let slot;
    let occupyingCount;
    if (nextStatus === "SCHEDULED") {
      const allocation = await tx.distributionAllocation.findUnique({
        where: {
          distributionId_beneficiaryId: {
            distributionId,
            beneficiaryId: schedule.beneficiaryId,
          },
        },
        select: { allocationId: true, allocationStatus: true },
      });
      if (!allocation) {
        throw new AppError(
          409,
          "ALLOCATION_NOT_SCHEDULABLE",
          "The schedule no longer has a distribution allocation.",
        );
      }
      assertAllocationSchedulable(allocation);
      slot = await getScheduleSlotOrThrow(distributionId, schedule.slotId, tx);
      assertDistributionSlotCoverage(slot, schedule.beneficiary);
      occupyingCount = await activeScheduleCount(schedule.slotId, tx);
      assertSlotAvailable(slot, occupyingCount);
    }

    const transition = await tx.schedule.updateMany({
      where: { distributionId, scheduleId, status: schedule.status },
      data: { status: nextStatus },
    });
    if (transition.count !== 1) {
      throw new AppError(
        409,
        "DISTRIBUTION_SCHEDULE_CONCURRENT_CHANGE",
        "Distribution schedule data changed concurrently. Refresh and try again.",
      );
    }
    if (nextStatus === "CANCELLED") {
      await releaseFullSlot(tx, schedule.slotId, distributionId);
    } else {
      await markSlotFullIfNeeded(tx, slot, occupyingCount + 1);
    }
    await createScheduleAudit(tx, req, schedule, action, {
      previousStatus: schedule.status,
      status: nextStatus,
    });
  });
  return getDistributionScheduleOrThrow(distributionId, scheduleId);
}

export const cancelDistributionSchedule = asyncHandler(async (req, res) => {
  assertDistributionScheduleManageAllowed(req.staffUser);
  const schedule = await transitionDistributionSchedule(
    req,
    "CANCELLED",
    "DISTRIBUTION_SCHEDULE_CANCELLED",
  );
  return res.status(200).json({
    success: true,
    data: { schedule: distributionScheduleToResponse(schedule) },
  });
});

export const reactivateDistributionSchedule = asyncHandler(async (req, res) => {
  assertDistributionScheduleManageAllowed(req.staffUser);
  const schedule = await transitionDistributionSchedule(
    req,
    "SCHEDULED",
    "DISTRIBUTION_SCHEDULE_REACTIVATED",
  );
  return res.status(200).json({
    success: true,
    data: { schedule: distributionScheduleToResponse(schedule) },
  });
});

export const openDistribution = asyncHandler(async (req, res) => {
  assertDistributionManageAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;

  await runScheduleTransaction(async (tx) => {
    const distribution = await getDistributionScheduleParentOrThrow(
      distributionId,
      req.staffUser,
      tx,
    );
    assertDistributionSchedulesManageable(distribution);
    const readiness = await distributionOpeningReadiness(distributionId, tx);
    const transition = await tx.distribution.updateMany({
      where: { distributionId, status: "DRAFT" },
      data: { status: "OPEN" },
    });
    if (transition.count !== 1) {
      throw new AppError(
        409,
        "DISTRIBUTION_STATUS_CHANGED",
        "Distribution event status changed while this request was being processed. Refresh and try again.",
      );
    }
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "DISTRIBUTION_OPENED",
        entityAffected: "DISTRIBUTION",
        recordId: distributionId,
        ipAddress: clientIpAddress(req),
        details: {
          previousStatus: distribution.status,
          status: "OPEN",
          ...readiness,
          schedulesFrozen: true,
          allocationsFrozen: true,
          slotsFrozen: true,
        },
      },
    });
  });

  const distribution = await prisma.distribution.findUniqueOrThrow({
    where: { distributionId },
    select: distributionSelect,
  });
  await publishDistributionUpdated(distribution, "OPENED");
  return res.status(200).json({
    success: true,
    data: { distribution: distributionToResponse(distribution) },
  });
});
