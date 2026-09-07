import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import {
  assertDistributionManageAllowed,
  assertDistributionReadAllowed,
  resolveDistributionListBarangay,
} from "./distribution.policy.js";
import {
  assertActiveDistributionBarangay,
  assertActiveDistributionProgram,
  assertDistributionConfigurationValid,
  assertDistributionDraft,
  assertDistributionTransition,
  assertNoDistributionOverlap,
  distributionSelect,
  distributionToResponse,
  getDistributionOrThrow,
} from "./distribution.service.js";
import { assertDistributionScheduleFieldsUnlocked } from "./distributionSlot.service.js";
import { assertDistributionAllocationFieldsUnlocked } from "./distributionAllocation.service.js";
import { publishDistributionUpdated } from "../../realtime/publishers.js";

async function runDistributionTransaction(operation) {
  try {
    return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error.code === "P2034") {
      throw new AppError(
        409,
        "DISTRIBUTION_CONCURRENT_CHANGE",
        "Distribution event data changed concurrently. Refresh and try again.",
      );
    }

    throw error;
  }
}

export const createDistribution = asyncHandler(async (req, res) => {
  assertDistributionManageAllowed(req.staffUser);
  assertDistributionConfigurationValid(req.validatedBody);

  const distributionId = await runDistributionTransaction(async (tx) => {
    await assertActiveDistributionProgram(req.validatedBody.programId, tx);
    await assertActiveDistributionBarangay(req.validatedBody.barangayId, tx);
    await assertNoDistributionOverlap(req.validatedBody, tx);

    const createdDistribution = await tx.distribution.create({
      data: {
        ...req.validatedBody,
        createdById: req.auth.userId,
        status: "DRAFT",
      },
      select: {
        distributionId: true,
        programId: true,
        barangayId: true,
        distributionDate: true,
        status: true,
      },
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "DISTRIBUTION_CREATED",
        entityAffected: "DISTRIBUTION",
        recordId: createdDistribution.distributionId,
        ipAddress: clientIpAddress(req),
        details: {
          programId: createdDistribution.programId,
          barangayId: createdDistribution.barangayId,
          distributionDate: createdDistribution.distributionDate.toISOString().slice(0, 10),
          status: createdDistribution.status,
        },
      },
    });

    return createdDistribution.distributionId;
  });
  const distribution = await prisma.distribution.findUniqueOrThrow({
    where: { distributionId },
    select: distributionSelect,
  });
  await publishDistributionUpdated(distribution, "CREATED");

  res.status(201).json({
    success: true,
    data: { distribution: distributionToResponse(distribution) },
  });
});

export const previewAssistantDistribution = asyncHandler(async (req, res) => {
  assertDistributionManageAllowed(req.staffUser);
  assertDistributionConfigurationValid(req.validatedBody);
  await Promise.all([
    assertActiveDistributionProgram(req.validatedBody.programId),
    assertActiveDistributionBarangay(req.validatedBody.barangayId),
    assertNoDistributionOverlap(req.validatedBody),
  ]);

  res.status(200).json({
    success: true,
    data: {
      conflictFree: true,
      draftOnly: true,
      checkedAt: new Date().toISOString(),
      message: "The event configuration is valid and has no current Barangay time conflict. Confirmation creates a draft only.",
    },
  });
});

export const listDistributions = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const {
    page,
    pageSize,
    programId,
    barangayId,
    status,
    dateFrom,
    dateTo,
  } = req.validatedQuery;
  const scopedBarangayId = resolveDistributionListBarangay(req.staffUser, barangayId);
  const where = {
    ...(programId ? { programId } : {}),
    ...(scopedBarangayId ? { barangayId: scopedBarangayId } : {}),
    ...(status ? { status } : {}),
    ...(dateFrom || dateTo ? {
      distributionDate: {
        ...(dateFrom ? { gte: dateFrom } : {}),
        ...(dateTo ? { lte: dateTo } : {}),
      },
    } : {}),
  };

  const [distributions, total] = await Promise.all([
    prisma.distribution.findMany({
      where,
      select: distributionSelect,
      orderBy: [
        { distributionDate: "desc" },
        { startTime: "asc" },
        { distributionId: "asc" },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.distribution.count({ where }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      distributions: distributions.map((distribution) => distributionToResponse(distribution)),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
  });
});

export const getDistribution = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const distribution = await getDistributionOrThrow(
    req.validatedParams.distributionId,
    req.staffUser,
  );

  res.status(200).json({
    success: true,
    data: { distribution: distributionToResponse(distribution) },
  });
});

export const updateDistribution = asyncHandler(async (req, res) => {
  assertDistributionManageAllowed(req.staffUser);
  const existingDistribution = await getDistributionOrThrow(
    req.validatedParams.distributionId,
    req.staffUser,
  );
  assertDistributionDraft(existingDistribution);
  const nextDistribution = { ...existingDistribution, ...req.validatedBody };
  assertDistributionConfigurationValid(nextDistribution);

  const distributionId = await runDistributionTransaction(async (tx) => {
    await assertDistributionScheduleFieldsUnlocked(
      req.validatedBody,
      existingDistribution.distributionId,
      tx,
    );
    await assertDistributionAllocationFieldsUnlocked(
      req.validatedBody,
      existingDistribution.distributionId,
      tx,
    );
    await assertActiveDistributionProgram(nextDistribution.programId, tx);
    await assertActiveDistributionBarangay(nextDistribution.barangayId, tx);
    await assertNoDistributionOverlap({
      distributionId: existingDistribution.distributionId,
      barangayId: nextDistribution.barangayId,
      distributionDate: nextDistribution.distributionDate,
      startTime: nextDistribution.startTime,
      endTime: nextDistribution.endTime,
    }, tx);

    const update = await tx.distribution.updateMany({
      where: {
        distributionId: existingDistribution.distributionId,
        status: "DRAFT",
      },
      data: req.validatedBody,
    });

    if (update.count !== 1) {
      throw new AppError(
        409,
        "DISTRIBUTION_STATUS_CHANGED",
        "Distribution event status changed while this request was being processed. Refresh and try again.",
      );
    }

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "DISTRIBUTION_UPDATED",
        entityAffected: "DISTRIBUTION",
        recordId: existingDistribution.distributionId,
        ipAddress: clientIpAddress(req),
        details: { changedFields: Object.keys(req.validatedBody) },
      },
    });

    return existingDistribution.distributionId;
  });
  const distribution = await prisma.distribution.findUniqueOrThrow({
    where: { distributionId },
    select: distributionSelect,
  });
  await publishDistributionUpdated(distribution, "UPDATED");

  res.status(200).json({
    success: true,
    data: { distribution: distributionToResponse(distribution) },
  });
});

export const cancelDistribution = asyncHandler(async (req, res) => {
  assertDistributionManageAllowed(req.staffUser);
  const existingDistribution = await getDistributionOrThrow(
    req.validatedParams.distributionId,
    req.staffUser,
  );
  assertDistributionTransition(existingDistribution, "CANCELLED");

  const distributionId = await runDistributionTransaction(async (tx) => {
    const transition = await tx.distribution.updateMany({
      where: {
        distributionId: existingDistribution.distributionId,
        status: existingDistribution.status,
      },
      data: { status: "CANCELLED" },
    });

    if (transition.count !== 1) {
      throw new AppError(
        409,
        "DISTRIBUTION_STATUS_CHANGED",
        "Distribution event status changed while this request was being processed. Refresh and try again.",
      );
    }

    const closedSlots = await tx.distributionSlot.updateMany({
      where: {
        distributionId: existingDistribution.distributionId,
        slotStatus: { not: "CLOSED" },
      },
      data: { slotStatus: "CLOSED" },
    });
    const cancelledAllocations = await tx.distributionAllocation.updateMany({
      where: {
        distributionId: existingDistribution.distributionId,
        allocationStatus: { in: ["PENDING", "ALLOCATED"] },
      },
      data: { allocationStatus: "CANCELLED" },
    });
    const cancelledSchedules = await tx.schedule.updateMany({
      where: {
        distributionId: existingDistribution.distributionId,
        status: { not: "CANCELLED" },
      },
      data: { status: "CANCELLED" },
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "DISTRIBUTION_CANCELLED",
        entityAffected: "DISTRIBUTION",
        recordId: existingDistribution.distributionId,
        ipAddress: clientIpAddress(req),
        details: {
          previousStatus: existingDistribution.status,
          status: "CANCELLED",
          closedSlotCount: closedSlots.count,
          cancelledAllocationCount: cancelledAllocations.count,
          cancelledScheduleCount: cancelledSchedules.count,
        },
      },
    });

    if (closedSlots.count > 0) {
      await tx.auditLog.create({
        data: {
          userId: req.auth.userId,
          action: "DISTRIBUTION_SLOTS_CLOSED_ON_CANCELLATION",
          entityAffected: "DISTRIBUTION_SLOT",
          recordId: existingDistribution.distributionId,
          ipAddress: clientIpAddress(req),
          details: { closedSlotCount: closedSlots.count },
        },
      });
    }

    if (cancelledAllocations.count > 0) {
      await tx.auditLog.create({
        data: {
          userId: req.auth.userId,
          action: "DISTRIBUTION_ALLOCATIONS_CANCELLED_ON_EVENT_CANCELLATION",
          entityAffected: "DISTRIBUTION_ALLOCATION",
          recordId: existingDistribution.distributionId,
          ipAddress: clientIpAddress(req),
          details: { cancelledAllocationCount: cancelledAllocations.count },
        },
      });
    }

    if (cancelledSchedules.count > 0) {
      await tx.auditLog.create({
        data: {
          userId: req.auth.userId,
          action: "DISTRIBUTION_SCHEDULES_CANCELLED_ON_EVENT_CANCELLATION",
          entityAffected: "SCHEDULE",
          recordId: existingDistribution.distributionId,
          ipAddress: clientIpAddress(req),
          details: { cancelledScheduleCount: cancelledSchedules.count },
        },
      });
    }

    return existingDistribution.distributionId;
  });
  const distribution = await prisma.distribution.findUniqueOrThrow({
    where: { distributionId },
    select: distributionSelect,
  });
  await publishDistributionUpdated(distribution, "CANCELLED");

  res.status(200).json({
    success: true,
    data: { distribution: distributionToResponse(distribution) },
  });
});
