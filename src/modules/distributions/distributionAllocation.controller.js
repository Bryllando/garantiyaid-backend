import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import {
  assertDistributionManageAllowed,
  assertDistributionReadAllowed,
} from "./distribution.policy.js";
import { idempotencyKeySchema } from "./distributionAllocation.schemas.js";
import {
  activeProgramAllocatedAmount,
  allocationGrantAmount,
  allocationRequestHash,
  assertDistributionAllocationsManageable,
  assertDistributionAllocationTransition,
  assertProgramBudgetAvailable,
  assertRequestedEnrollmentsEligible,
  buildAllocationSearchWhere,
  buildEligibleEnrollmentSearchWhere,
  distributionAllocationSelect,
  distributionAllocationToResponse,
  eligibleEnrollmentSelect,
  getDistributionAllocationOrThrow,
  getDistributionAllocationParentOrThrow,
  getDistributionAllocationMutationParentOrThrow,
  getDistributionAllocationMutationRecordOrThrow,
} from "./distributionAllocation.service.js";
import { OCCUPYING_SCHEDULE_STATUSES } from "./distributionSchedule.service.js";

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function allocationIdempotencyKey(req) {
  const rawKey = req.get("idempotency-key");
  if (!rawKey) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "An Idempotency-Key UUID header is required when creating allocations.",
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
      "This Idempotency-Key was already used with a different allocation request.",
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

async function runAllocationTransaction(operation) {
  try {
    return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error.code === "P2034") {
      throw new AppError(
        409,
        "DISTRIBUTION_ALLOCATION_CONCURRENT_CHANGE",
        "Distribution allocation data changed concurrently. Refresh and try again.",
      );
    }

    throw error;
  }
}

function budgetAmountString(value) {
  return Number(value ?? 0).toFixed(2);
}

export const listEligibleDistributionEnrollments = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { page, pageSize, search } = req.validatedQuery;
  const distribution = await getDistributionAllocationParentOrThrow(
    distributionId,
    req.staffUser,
  );

  const where = {
    programId: distribution.programId,
    status: "APPROVED",
    beneficiary: {
      barangayId: distribution.barangayId,
      status: "ACTIVE",
    },
    allocations: { none: { distributionId } },
    ...buildEligibleEnrollmentSearchWhere(search),
  };
  const [enrollments, total] = await Promise.all([
    prisma.enrollment.findMany({
      where,
      select: eligibleEnrollmentSelect,
      orderBy: [
        { beneficiary: { lastName: "asc" } },
        { beneficiary: { firstName: "asc" } },
        { enrollmentId: "asc" },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.enrollment.count({ where }),
  ]);

  return res.status(200).json({
    success: true,
    data: {
      enrollments,
      allocationAmount: distribution.program.grantAmount?.toString() ?? null,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    },
  });
});

export const createDistributionAllocations = asyncHandler(async (req, res) => {
  assertDistributionManageAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { enrollmentIds } = req.validatedBody;
  const idempotencyKey = allocationIdempotencyKey(req);
  const operation = `DISTRIBUTION_ALLOCATION_BATCH:${distributionId}`;
  const requestHash = allocationRequestHash(enrollmentIds);
  const idempotencyIdentity = {
    userId: req.auth.userId,
    operation,
    idempotencyKey,
  };

  await prisma.idempotencyRecord.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
  const existingRecord = await findUsableIdempotencyRecord(idempotencyIdentity);
  if (existingRecord) {
    assertMatchingIdempotencyRequest(existingRecord, requestHash);
    res.set("Idempotency-Replayed", "true");
    return res.status(existingRecord.responseStatus).json(existingRecord.responseBody);
  }

  let result;
  try {
    result = await runAllocationTransaction(async (tx) => {
      const transactionRecord = await tx.idempotencyRecord.findUnique({
        where: {
          userId_operation_idempotencyKey: idempotencyIdentity,
        },
      });
      if (transactionRecord && transactionRecord.expiresAt > new Date()) {
        assertMatchingIdempotencyRequest(transactionRecord, requestHash);
        return {
          replayed: true,
          responseStatus: transactionRecord.responseStatus,
          responseBody: transactionRecord.responseBody,
        };
      }

      const distribution = await getDistributionAllocationMutationParentOrThrow(
        distributionId,
        req.staffUser,
        tx,
      );
      assertDistributionAllocationsManageable(distribution);
      const grantAmount = allocationGrantAmount(distribution.program);

      const enrollmentRows = await tx.enrollment.findMany({
        where: { enrollmentId: { in: enrollmentIds } },
        select: {
          enrollmentId: true,
          beneficiaryId: true,
          programId: true,
          enrollmentDate: true,
          status: true,
          reviewedAt: true,
        },
      });
      const beneficiaryRows = await tx.beneficiary.findMany({
        where: { beneficiaryId: { in: enrollmentRows.map((row) => row.beneficiaryId) } },
        select: {
          beneficiaryId: true,
          barangayId: true,
          status: true,
        },
      });
      const beneficiariesById = new Map(beneficiaryRows.map((beneficiary) => [
        beneficiary.beneficiaryId,
        beneficiary,
      ]));
      const enrollments = enrollmentRows.map((enrollment) => ({
        ...enrollment,
        beneficiary: beneficiariesById.get(enrollment.beneficiaryId),
      }));
      assertRequestedEnrollmentsEligible(enrollments, enrollmentIds, distribution);

      const duplicateAllocation = await tx.distributionAllocation.findFirst({
        where: {
          distributionId,
          enrollmentId: { in: enrollmentIds },
        },
        select: { enrollmentId: true },
      });
      if (duplicateAllocation) {
        throw new AppError(
          409,
          "DISTRIBUTION_ALLOCATION_ALREADY_EXISTS",
          "An allocation already exists for one of the requested enrollments in this event.",
          { enrollmentId: duplicateAllocation.enrollmentId },
        );
      }

      const allocatedAmount = await activeProgramAllocatedAmount(distribution.programId, tx);
      const requestedAmount = grantAmount * enrollmentIds.length;
      assertProgramBudgetAvailable({
        budgetAmount: distribution.program.budgetAmount,
        allocatedAmount,
        requestedAmount,
      });

      const now = new Date();
      const enrollmentsById = new Map(enrollments.map((enrollment) => [
        enrollment.enrollmentId,
        enrollment,
      ]));
      const rows = enrollmentIds.map((enrollmentId) => ({
        allocationId: randomUUID(),
        distributionId,
        beneficiaryId: enrollmentsById.get(enrollmentId).beneficiaryId,
        enrollmentId,
        amount: distribution.program.grantAmount,
        allocationStatus: "ALLOCATED",
        allocatedById: req.auth.userId,
        allocatedAt: now,
        createdAt: now,
        updatedAt: now,
      }));
      await tx.distributionAllocation.createMany({ data: rows });
      await tx.auditLog.createMany({
        data: rows.map((row) => ({
          userId: req.auth.userId,
          action: "DISTRIBUTION_ALLOCATION_CREATED",
          entityAffected: "DISTRIBUTION_ALLOCATION",
          recordId: row.allocationId,
          ipAddress: clientIpAddress(req),
          details: {
            distributionId,
            enrollmentId: row.enrollmentId,
            beneficiaryId: row.beneficiaryId,
            amount: row.amount.toString(),
            allocationStatus: row.allocationStatus,
          },
        })),
      });

      const responseBody = jsonSafe({
        success: true,
        data: {
          allocations: rows.map(distributionAllocationToResponse),
          summary: {
            allocationCount: rows.length,
            amountPerBeneficiary: grantAmount.toFixed(2),
            totalAmount: requestedAmount.toFixed(2),
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
    const mayBeConcurrentIdempotentRequest = error.code === "P2002"
      || error.code === "DISTRIBUTION_ALLOCATION_CONCURRENT_CHANGE";
    if (!mayBeConcurrentIdempotentRequest) {
      throw error;
    }

    const concurrentRecord = await findUsableIdempotencyRecord(idempotencyIdentity);
    if (!concurrentRecord) {
      if (error.code === "DISTRIBUTION_ALLOCATION_CONCURRENT_CHANGE") {
        throw error;
      }
      throw new AppError(
        409,
        "DISTRIBUTION_ALLOCATION_ALREADY_EXISTS",
        "An allocation already exists for one of the requested enrollments in this event.",
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

export const listDistributionAllocations = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { page, pageSize, search, status } = req.validatedQuery;
  await getDistributionAllocationParentOrThrow(distributionId, req.staffUser);

  const matchingWhere = {
    distributionId,
    ...(status ? { allocationStatus: status } : {}),
    ...buildAllocationSearchWhere(search),
  };
  const allWhere = { distributionId };
  const [allocations, total, matchingAmount, totalAmount, statusGroups] = await Promise.all([
    prisma.distributionAllocation.findMany({
      where: matchingWhere,
      select: distributionAllocationSelect,
      orderBy: [{ createdAt: "desc" }, { allocationId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.distributionAllocation.count({ where: matchingWhere }),
    prisma.distributionAllocation.aggregate({ where: matchingWhere, _sum: { amount: true } }),
    prisma.distributionAllocation.aggregate({ where: allWhere, _sum: { amount: true } }),
    prisma.distributionAllocation.groupBy({
      by: ["allocationStatus"],
      where: allWhere,
      _count: { _all: true },
    }),
  ]);
  const countsByStatus = Object.fromEntries(
    statusGroups.map((group) => [group.allocationStatus, group._count._all]),
  );

  return res.status(200).json({
    success: true,
    data: {
      allocations: allocations.map(distributionAllocationToResponse),
      summary: {
        matchingAllocationCount: total,
        matchingAmount: budgetAmountString(matchingAmount._sum.amount),
        totalAmount: budgetAmountString(totalAmount._sum.amount),
        countsByStatus,
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

export const getDistributionAllocation = asyncHandler(async (req, res) => {
  assertDistributionReadAllowed(req.staffUser);
  const { distributionId, allocationId } = req.validatedParams;
  await getDistributionAllocationParentOrThrow(distributionId, req.staffUser);
  const allocation = await getDistributionAllocationOrThrow(distributionId, allocationId);

  return res.status(200).json({
    success: true,
    data: { allocation: distributionAllocationToResponse(allocation) },
  });
});

async function transitionDistributionAllocation(req, nextStatus, action) {
  const { distributionId, allocationId } = req.validatedParams;

  return runAllocationTransaction(async (tx) => {
    const distribution = await getDistributionAllocationMutationParentOrThrow(
      distributionId,
      req.staffUser,
      tx,
    );
    assertDistributionAllocationsManageable(distribution);
    const allocation = await getDistributionAllocationMutationRecordOrThrow(
      distributionId,
      allocationId,
      tx,
    );
    assertDistributionAllocationTransition(allocation, nextStatus);

    if (nextStatus === "ALLOCATED") {
      allocationGrantAmount(distribution.program);
      const allocatedAmount = await activeProgramAllocatedAmount(distribution.programId, tx);
      assertProgramBudgetAvailable({
        budgetAmount: distribution.program.budgetAmount,
        allocatedAmount,
        requestedAmount: Number(allocation.amount),
      });
    }

    const transition = await tx.distributionAllocation.updateMany({
      where: {
        distributionId,
        allocationId,
        allocationStatus: allocation.allocationStatus,
      },
      data: { allocationStatus: nextStatus },
    });
    if (transition.count !== 1) {
      throw new AppError(
        409,
        "DISTRIBUTION_ALLOCATION_CONCURRENT_CHANGE",
        "Distribution allocation data changed concurrently. Refresh and try again.",
      );
    }

    let cancelledSchedule = null;
    if (nextStatus === "CANCELLED") {
      cancelledSchedule = await tx.schedule.findUnique({
        where: {
          distributionId_beneficiaryId: {
            distributionId,
            beneficiaryId: allocation.beneficiaryId,
          },
        },
        select: {
          scheduleId: true,
          slotId: true,
          queueNumber: true,
          status: true,
        },
      });
      if (cancelledSchedule && OCCUPYING_SCHEDULE_STATUSES.includes(cancelledSchedule.status)) {
        const scheduleTransition = await tx.schedule.updateMany({
          where: {
            scheduleId: cancelledSchedule.scheduleId,
            status: cancelledSchedule.status,
          },
          data: { status: "CANCELLED" },
        });
        if (scheduleTransition.count !== 1) {
          throw new AppError(
            409,
            "DISTRIBUTION_ALLOCATION_CONCURRENT_CHANGE",
            "The allocation schedule changed concurrently. Refresh and try again.",
          );
        }
        await tx.distributionSlot.updateMany({
          where: {
            slotId: cancelledSchedule.slotId,
            distributionId,
            slotStatus: "FULL",
          },
          data: { slotStatus: "AVAILABLE" },
        });
        await tx.auditLog.create({
          data: {
            userId: req.auth.userId,
            action: "DISTRIBUTION_SCHEDULE_CANCELLED_WITH_ALLOCATION",
            entityAffected: "SCHEDULE",
            recordId: cancelledSchedule.scheduleId,
            ipAddress: clientIpAddress(req),
            details: {
              distributionId,
              allocationId,
              beneficiaryId: allocation.beneficiaryId,
              slotId: cancelledSchedule.slotId,
              queueNumber: cancelledSchedule.queueNumber,
              previousStatus: cancelledSchedule.status,
              status: "CANCELLED",
            },
          },
        });
      }
    }

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action,
        entityAffected: "DISTRIBUTION_ALLOCATION",
        recordId: allocationId,
        ipAddress: clientIpAddress(req),
        details: {
          distributionId,
          enrollmentId: allocation.enrollmentId,
          beneficiaryId: allocation.beneficiaryId,
          previousStatus: allocation.allocationStatus,
          allocationStatus: nextStatus,
          ...(cancelledSchedule ? { scheduleId: cancelledSchedule.scheduleId } : {}),
        },
      },
    });

    return allocationId;
  });
}

export const cancelDistributionAllocation = asyncHandler(async (req, res) => {
  assertDistributionManageAllowed(req.staffUser);
  const allocationId = await transitionDistributionAllocation(
    req,
    "CANCELLED",
    "DISTRIBUTION_ALLOCATION_CANCELLED",
  );
  const allocation = await getDistributionAllocationOrThrow(
    req.validatedParams.distributionId,
    allocationId,
  );
  return res.status(200).json({
    success: true,
    data: { allocation: distributionAllocationToResponse(allocation) },
  });
});

export const reactivateDistributionAllocation = asyncHandler(async (req, res) => {
  assertDistributionManageAllowed(req.staffUser);
  const allocationId = await transitionDistributionAllocation(
    req,
    "ALLOCATED",
    "DISTRIBUTION_ALLOCATION_REACTIVATED",
  );
  const allocation = await getDistributionAllocationOrThrow(
    req.validatedParams.distributionId,
    allocationId,
  );
  return res.status(200).json({
    success: true,
    data: { allocation: distributionAllocationToResponse(allocation) },
  });
});
