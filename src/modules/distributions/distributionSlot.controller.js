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

export const generateDistributionSlots = asyncHandler(async (req, res) => {
  assertDistributionManageAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { capacity } = req.validatedBody;

  const generatedCount = await runSlotTransaction(async (tx) => {
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

    const rows = buildDistributionSlotRows(distribution, capacity);
    await tx.distributionSlot.createMany({ data: rows });
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "DISTRIBUTION_SLOTS_GENERATED",
        entityAffected: "DISTRIBUTION_SLOT",
        recordId: distributionId,
        ipAddress: clientIpAddress(req),
        details: {
          slotCount: rows.length,
          capacityPerSlot: capacity,
          totalCapacity: rows.length * capacity,
          timeZone: "Asia/Manila",
        },
      },
    });

    return rows.length;
  });

  const slots = await readGeneratedSlots(distributionId);
  return res.status(201).json({
    success: true,
    data: {
      slots: slots.map(distributionSlotToResponse),
      summary: {
        slotCount: generatedCount,
        totalCapacity: generatedCount * capacity,
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
  const [slots, total, capacity] = await Promise.all([
    prisma.distributionSlot.findMany({
      where,
      select: distributionSlotSelect,
      orderBy: [{ slotStart: "asc" }, { slotId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.distributionSlot.count({ where }),
    prisma.distributionSlot.aggregate({ where, _sum: { capacity: true } }),
  ]);

  return res.status(200).json({
    success: true,
    data: {
      slots: slots.map(distributionSlotToResponse),
      summary: {
        matchingSlotCount: total,
        matchingCapacity: capacity._sum.capacity ?? 0,
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
