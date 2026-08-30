import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import {
  assertDistributionManageAllowed,
  assertDistributionReadAllowed,
} from "./distribution.policy.js";
import {
  assertDistributionSlotsManageable,
  assertDistributionSlotTransition,
  buildDistributionSlotRows,
  distributionSlotSelect,
  distributionSlotToResponse,
  getDistributionSlotOrThrow,
  getDistributionSlotParentOrThrow,
} from "./distributionSlot.service.js";

async function runSlotTransaction(operation) {
  try {
    return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error.code === "P2034") {
      throw new AppError(
        409,
        "DISTRIBUTION_SLOT_CONCURRENT_CHANGE",
        "Distribution slot data changed concurrently. Refresh and try again.",
      );
    }

    if (error.code === "P2002") {
      throw new AppError(
        409,
        "DISTRIBUTION_SLOTS_ALREADY_EXIST",
        "Slots have already been generated for this distribution event.",
      );
    }

    throw error;
  }
}

async function readGeneratedSlots(distributionId) {
  return prisma.distributionSlot.findMany({
    where: { distributionId },
    select: distributionSlotSelect,
    orderBy: [{ slotStart: "asc" }, { slotId: "asc" }],
  });
}

async function assertNoSessionSlotConflict(database, distribution, rows) {
  const boundsBySession = new Map();
  for (const row of rows) {
    const bounds = boundsBySession.get(row.sessionId) ?? {
      startsAt: row.slotStart,
      endsAt: row.slotEnd,
    };
    if (row.slotStart < bounds.startsAt) bounds.startsAt = row.slotStart;
    if (row.slotEnd > bounds.endsAt) bounds.endsAt = row.slotEnd;
    boundsBySession.set(row.sessionId, bounds);
  }
  const conflict = await database.distributionSlot.findFirst({
    where: {
      distributionId: { not: distribution.distributionId },
      distribution: {
        barangayId: distribution.barangayId,
        status: { not: "CANCELLED" },
      },
      OR: [...boundsBySession.values()].map((bounds) => ({
        slotStart: { lt: bounds.endsAt },
        slotEnd: { gt: bounds.startsAt },
      })),
    },
    select: { distributionId: true, sessionLabel: true, slotStart: true, slotEnd: true },
  });
  if (conflict) {
    throw new AppError(
      409,
      "DISTRIBUTION_SESSION_TIME_CONFLICT",
      "A service session overlaps another distribution event in this Barangay.",
      { conflictingDistributionId: conflict.distributionId },
    );
  }
}

export const generateDistributionSlots = asyncHandler(async (req, res) => {
  assertDistributionManageAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { capacity, sessions } = req.validatedBody;

  const generated = await runSlotTransaction(async (tx) => {
    const distribution = await getDistributionSlotParentOrThrow(
      distributionId,
      req.staffUser,
      tx,
    );
    assertDistributionSlotsManageable(distribution);

    const existingSlotCount = await tx.distributionSlot.count({
      where: { distributionId },
    });
    if (existingSlotCount > 0) {
      throw new AppError(
        409,
        "DISTRIBUTION_SLOTS_ALREADY_EXIST",
        "Slots have already been generated for this distribution event.",
      );
    }

    const rows = buildDistributionSlotRows(distribution, sessions ?? capacity);
    await assertNoSessionSlotConflict(tx, distribution, rows);
    await tx.distributionSlot.createMany({ data: rows });
    const sessionCount = new Set(rows.map((row) => row.sessionId)).size;
    const totalCapacity = rows.reduce((total, row) => total + row.capacity, 0);
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "DISTRIBUTION_SLOTS_GENERATED",
        entityAffected: "DISTRIBUTION_SLOT",
        recordId: distributionId,
        ipAddress: clientIpAddress(req),
        details: {
          slotCount: rows.length,
          sessionCount,
          totalCapacity,
          coverageMode: rows.some((row) => row.serviceAreas.length > 0)
            ? "BY_SERVICE_AREA"
            : "WHOLE_BARANGAY",
          timeZone: "Asia/Manila",
        },
      },
    });

    return { slotCount: rows.length, sessionCount, totalCapacity };
  });

  const slots = await readGeneratedSlots(distributionId);
  return res.status(201).json({
    success: true,
    data: {
      slots: slots.map(distributionSlotToResponse),
      summary: {
        ...generated,
        timeZone: "Asia/Manila",
      },
    },
  });
});

export const listDistributionSlots = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { page, pageSize, slotStatus } = req.validatedQuery;
  await getDistributionSlotParentOrThrow(distributionId, req.staffUser);

  const where = {
    distributionId,
    ...(slotStatus ? { slotStatus } : {}),
  };
  const [slots, total, capacity, sessionGroups] = await Promise.all([
    prisma.distributionSlot.findMany({
      where,
      select: distributionSlotSelect,
      orderBy: [{ slotStart: "asc" }, { slotId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.distributionSlot.count({ where }),
    prisma.distributionSlot.aggregate({ where, _sum: { capacity: true } }),
    prisma.distributionSlot.groupBy({ by: ["sessionId"], where }),
  ]);

  return res.status(200).json({
    success: true,
    data: {
      slots: slots.map(distributionSlotToResponse),
      summary: {
        matchingSlotCount: total,
        matchingCapacity: capacity._sum.capacity ?? 0,
        sessionCount: sessionGroups.length,
        timeZone: "Asia/Manila",
      },
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    },
  });
});

export const getDistributionSlot = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId, slotId } = req.validatedParams;
  await getDistributionSlotParentOrThrow(distributionId, req.staffUser);
  const slot = await getDistributionSlotOrThrow(distributionId, slotId);

  return res.status(200).json({
    success: true,
    data: { slot: distributionSlotToResponse(slot) },
  });
});

export const updateDistributionSlot = asyncHandler(async (req, res) => {
  assertDistributionManageAllowed(req.staffUser);
  const { distributionId, slotId } = req.validatedParams;
  const { capacity } = req.validatedBody;

  await runSlotTransaction(async (tx) => {
    const distribution = await getDistributionSlotParentOrThrow(
      distributionId,
      req.staffUser,
      tx,
    );
    assertDistributionSlotsManageable(distribution);
    const slot = await getDistributionSlotOrThrow(distributionId, slotId, tx);
    const scheduledCount = await tx.schedule.count({
      where: { slotId, status: { not: "CANCELLED" } },
    });
    if (capacity < scheduledCount) {
      throw new AppError(
        409,
        "DISTRIBUTION_SLOT_CAPACITY_BELOW_USAGE",
        "Slot capacity cannot be lower than the number of existing schedules.",
        { scheduledCount },
      );
    }

    const nextSlotStatus = slot.slotStatus === "CLOSED"
      ? "CLOSED"
      : (capacity === scheduledCount ? "FULL" : "AVAILABLE");
    const update = await tx.distributionSlot.updateMany({
      where: {
        slotId,
        distributionId,
        capacity: slot.capacity,
      },
      data: { capacity, slotStatus: nextSlotStatus },
    });
    if (update.count !== 1) {
      throw new AppError(
        409,
        "DISTRIBUTION_SLOT_CONCURRENT_CHANGE",
        "Distribution slot data changed concurrently. Refresh and try again.",
      );
    }

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "DISTRIBUTION_SLOT_CAPACITY_UPDATED",
        entityAffected: "DISTRIBUTION_SLOT",
        recordId: slotId,
        ipAddress: clientIpAddress(req),
        details: {
          distributionId,
          previousCapacity: slot.capacity,
          capacity,
          previousSlotStatus: slot.slotStatus,
          slotStatus: nextSlotStatus,
        },
      },
    });
  });

  const slot = await getDistributionSlotOrThrow(distributionId, slotId);
  return res.status(200).json({
    success: true,
    data: { slot: distributionSlotToResponse(slot) },
  });
});

async function transitionDistributionSlot(req, nextStatus, action) {
  const { distributionId, slotId } = req.validatedParams;

  await runSlotTransaction(async (tx) => {
    const distribution = await getDistributionSlotParentOrThrow(
      distributionId,
      req.staffUser,
      tx,
    );
    assertDistributionSlotsManageable(distribution);
    const slot = await getDistributionSlotOrThrow(distributionId, slotId, tx);
    assertDistributionSlotTransition(slot, nextStatus);

    if (nextStatus === "CLOSED") {
      const activeScheduleCount = await tx.schedule.count({
        where: { slotId, status: { not: "CANCELLED" } },
      });
      if (activeScheduleCount > 0) {
        throw new AppError(
          409,
          "DISTRIBUTION_SLOT_HAS_ACTIVE_SCHEDULES",
          "A slot with active schedules cannot be closed.",
          { activeScheduleCount },
        );
      }
    }

    const transition = await tx.distributionSlot.updateMany({
      where: {
        slotId,
        distributionId,
        slotStatus: slot.slotStatus,
      },
      data: { slotStatus: nextStatus },
    });
    if (transition.count !== 1) {
      throw new AppError(
        409,
        "DISTRIBUTION_SLOT_CONCURRENT_CHANGE",
        "Distribution slot data changed concurrently. Refresh and try again.",
      );
    }

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action,
        entityAffected: "DISTRIBUTION_SLOT",
        recordId: slotId,
        ipAddress: clientIpAddress(req),
        details: {
          distributionId,
          previousStatus: slot.slotStatus,
          slotStatus: nextStatus,
        },
      },
    });
  });

  return getDistributionSlotOrThrow(distributionId, slotId);
}

export const closeDistributionSlot = asyncHandler(async (req, res) => {
  assertDistributionManageAllowed(req.staffUser);
  const slot = await transitionDistributionSlot(
    req,
    "CLOSED",
    "DISTRIBUTION_SLOT_CLOSED",
  );
  return res.status(200).json({
    success: true,
    data: { slot: distributionSlotToResponse(slot) },
  });
});

export const reopenDistributionSlot = asyncHandler(async (req, res) => {
  assertDistributionManageAllowed(req.staffUser);
  const slot = await transitionDistributionSlot(
    req,
    "AVAILABLE",
    "DISTRIBUTION_SLOT_REOPENED",
  );
  return res.status(200).json({
    success: true,
    data: { slot: distributionSlotToResponse(slot) },
  });
});
