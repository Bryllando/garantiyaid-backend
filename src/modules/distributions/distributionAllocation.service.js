import { createHash } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { distributionAccessWhere } from "./distribution.policy.js";

const allocationStaffSelect = {
  userId: true,
  employeeId: true,
  username: true,
  fullName: true,
  role: true,
};

export const allocationBeneficiarySelect = {
  beneficiaryId: true,
  firstName: true,
  middleName: true,
  lastName: true,
  barangayId: true,
  sitioPurok: true,
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

export const eligibleEnrollmentSelect = {
  enrollmentId: true,
  beneficiaryId: true,
  programId: true,
  enrollmentDate: true,
  status: true,
  reviewedAt: true,
  beneficiary: { select: allocationBeneficiarySelect },
};

export const distributionAllocationSelect = {
  allocationId: true,
  distributionId: true,
  beneficiaryId: true,
  enrollmentId: true,
  amount: true,
  allocationStatus: true,
  allocatedById: true,
  allocatedAt: true,
  createdAt: true,
  updatedAt: true,
  beneficiary: { select: allocationBeneficiarySelect },
  enrollment: {
    select: {
      enrollmentId: true,
      programId: true,
      status: true,
      reviewedAt: true,
    },
  },
  allocatedBy: { select: allocationStaffSelect },
};

export const distributionAllocationParentSelect = {
  distributionId: true,
  programId: true,
  barangayId: true,
  status: true,
  slots: { select: { serviceAreas: true } },
  program: {
    select: {
      programId: true,
      programName: true,
      programCode: true,
      status: true,
      grantAmount: true,
      budgetAmount: true,
    },
  },
};

function normalizedServiceArea(value) {
  return value?.trim().toLocaleLowerCase("en-PH") ?? "";
}

export function distributionCoveredServiceAreas(distribution) {
  const areas = distribution.slots?.flatMap((slot) => slot.serviceAreas) ?? [];
  return [...new Map(areas.map((area) => [normalizedServiceArea(area), area])).values()];
}

export const distributionAllocationMutationSelect = {
  allocationId: true,
  distributionId: true,
  beneficiaryId: true,
  enrollmentId: true,
  amount: true,
  allocationStatus: true,
  allocatedById: true,
  allocatedAt: true,
  createdAt: true,
  updatedAt: true,
};

export function distributionAllocationToResponse(allocation) {
  return {
    ...allocation,
    amount: allocation.amount.toString(),
  };
}

export function allocationRequestHash(enrollmentIds) {
  const normalized = [...enrollmentIds].sort();
  return createHash("sha256").update(JSON.stringify({ enrollmentIds: normalized })).digest("hex");
}

export function assertDistributionAllocationsManageable(distribution) {
  if (distribution.status !== "DRAFT") {
    throw new AppError(
      409,
      "DISTRIBUTION_ALLOCATIONS_NOT_EDITABLE",
      "Allocations can only be managed while the distribution event is in draft status.",
    );
  }
}

export function allocationGrantAmount(program) {
  if (program.status !== "ACTIVE") {
    throw new AppError(
      409,
      "PROGRAM_NOT_ACTIVE",
      "Allocations can only be created or reactivated for an active assistance program.",
    );
  }

  const amount = program.grantAmount == null ? 0 : Number(program.grantAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError(
      409,
      "PROGRAM_GRANT_AMOUNT_REQUIRED",
      "The assistance program must have a positive grant amount before allocations are created.",
    );
  }

  return amount;
}

export function assertRequestedEnrollmentsEligible(enrollments, enrollmentIds, distribution) {
  const enrollmentsById = new Map(enrollments.map((enrollment) => [
    enrollment.enrollmentId,
    enrollment,
  ]));
  const coveredAreas = distributionCoveredServiceAreas(distribution);
  const normalizedCoveredAreas = new Set(coveredAreas.map(normalizedServiceArea));

  for (const enrollmentId of enrollmentIds) {
    const enrollment = enrollmentsById.get(enrollmentId);
    if (!enrollment) {
      throw new AppError(
        409,
        "ENROLLMENT_NOT_ELIGIBLE_FOR_ALLOCATION",
        "Every requested enrollment must exist and be eligible for this distribution event.",
      );
    }
    if (enrollment.status !== "APPROVED") {
      throw new AppError(
        409,
        "ENROLLMENT_NOT_APPROVED",
        "Only approved enrollments can be allocated to a distribution event.",
        { enrollmentId },
      );
    }
    if (enrollment.programId !== distribution.programId) {
      throw new AppError(
        409,
        "ENROLLMENT_PROGRAM_MISMATCH",
        "The enrollment program does not match the distribution event program.",
        { enrollmentId },
      );
    }
    if (enrollment.beneficiary.barangayId !== distribution.barangayId) {
      throw new AppError(
        409,
        "ENROLLMENT_BARANGAY_MISMATCH",
        "The beneficiary barangay does not match the distribution event barangay.",
        { enrollmentId },
      );
    }
    if (enrollment.beneficiary.status !== "ACTIVE") {
      throw new AppError(
        409,
        "BENEFICIARY_NOT_ACTIVE",
        "Only active beneficiaries can receive distribution allocations.",
        { enrollmentId },
      );
    }
    if (
      normalizedCoveredAreas.size > 0
      && !normalizedCoveredAreas.has(normalizedServiceArea(enrollment.beneficiary.sitioPurok))
    ) {
      throw new AppError(
        409,
        "ENROLLMENT_SERVICE_AREA_MISMATCH",
        "The beneficiary's Sitio or Purok is not covered by this distribution event.",
        { enrollmentId, sitioPurok: enrollment.beneficiary.sitioPurok ?? null },
      );
    }
  }
}

export function assertProgramBudgetAvailable({ budgetAmount, allocatedAmount, requestedAmount }) {
  if (budgetAmount == null) {
    return;
  }

  const budget = Number(budgetAmount);
  const allocated = Number(allocatedAmount ?? 0);
  if (allocated + requestedAmount > budget) {
    throw new AppError(
      409,
      "PROGRAM_BUDGET_EXCEEDED",
      "Creating or reactivating this allocation would exceed the assistance program budget.",
      {
        budgetAmount: budget.toFixed(2),
        allocatedAmount: allocated.toFixed(2),
        requestedAmount: requestedAmount.toFixed(2),
        remainingAmount: Math.max(0, budget - allocated).toFixed(2),
      },
    );
  }
}

export function assertDistributionAllocationTransition(allocation, nextStatus) {
  const allowedTransitions = {
    ALLOCATED: ["CANCELLED"],
    CANCELLED: ["ALLOCATED"],
    CLAIMED: [],
    PENDING: [],
  };

  if (!allowedTransitions[allocation.allocationStatus]?.includes(nextStatus)) {
    throw new AppError(
      409,
      allocation.allocationStatus === "CLAIMED"
        ? "CLAIMED_ALLOCATION_IMMUTABLE"
        : "INVALID_DISTRIBUTION_ALLOCATION_TRANSITION",
      allocation.allocationStatus === "CLAIMED"
        ? "A claimed allocation cannot be cancelled or reactivated."
        : `Distribution allocation cannot transition from ${allocation.allocationStatus} to ${nextStatus}.`,
    );
  }
}

export function buildAllocationSearchWhere(search) {
  if (!search) {
    return {};
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(search);
  return {
    OR: [
      ...(isUuid ? [
        { allocationId: search },
        { enrollmentId: search },
        { beneficiaryId: search },
      ] : []),
      { beneficiary: { firstName: { contains: search, mode: "insensitive" } } },
      { beneficiary: { middleName: { contains: search, mode: "insensitive" } } },
      { beneficiary: { lastName: { contains: search, mode: "insensitive" } } },
    ],
  };
}

export function buildEligibleEnrollmentSearchWhere(search) {
  if (!search) {
    return {};
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(search);
  return {
    OR: [
      ...(isUuid ? [{ enrollmentId: search }, { beneficiaryId: search }] : []),
      { beneficiary: { firstName: { contains: search, mode: "insensitive" } } },
      { beneficiary: { middleName: { contains: search, mode: "insensitive" } } },
      { beneficiary: { lastName: { contains: search, mode: "insensitive" } } },
    ],
  };
}

export async function getDistributionAllocationParentOrThrow(
  distributionId,
  staffUser,
  database = prisma,
) {
  const distribution = await database.distribution.findFirst({
    where: {
      distributionId,
      ...distributionAccessWhere(staffUser),
    },
    select: distributionAllocationParentSelect,
  });

  if (!distribution) {
    throw new AppError(404, "DISTRIBUTION_NOT_FOUND", "Distribution event was not found.");
  }

  return distribution;
}

export async function getDistributionAllocationMutationParentOrThrow(
  distributionId,
  staffUser,
  database = prisma,
) {
  const distribution = await database.distribution.findFirst({
    where: {
      distributionId,
      ...distributionAccessWhere(staffUser),
    },
    select: {
      distributionId: true,
      programId: true,
      barangayId: true,
      status: true,
      slots: { select: { serviceAreas: true } },
    },
  });
  if (!distribution) {
    throw new AppError(404, "DISTRIBUTION_NOT_FOUND", "Distribution event was not found.");
  }

  const program = await database.program.findUnique({
    where: { programId: distribution.programId },
    select: {
      programId: true,
      programName: true,
      programCode: true,
      status: true,
      grantAmount: true,
      budgetAmount: true,
    },
  });
  if (!program) {
    throw new AppError(404, "PROGRAM_NOT_FOUND", "Assistance program was not found.");
  }

  return { ...distribution, program };
}

export async function getDistributionAllocationOrThrow(
  distributionId,
  allocationId,
  database = prisma,
) {
  const allocation = await database.distributionAllocation.findFirst({
    where: { distributionId, allocationId },
    select: distributionAllocationSelect,
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

export async function getDistributionAllocationMutationRecordOrThrow(
  distributionId,
  allocationId,
  database = prisma,
) {
  const allocation = await database.distributionAllocation.findFirst({
    where: { distributionId, allocationId },
    select: distributionAllocationMutationSelect,
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

export async function activeProgramAllocatedAmount(programId, database = prisma) {
  const aggregate = await database.distributionAllocation.aggregate({
    where: {
      distribution: { programId },
      allocationStatus: { in: ["PENDING", "ALLOCATED", "CLAIMED"] },
    },
    _sum: { amount: true },
  });
  return aggregate._sum.amount ?? 0;
}

export async function assertDistributionAllocationFieldsUnlocked(
  update,
  distributionId,
  database = prisma,
) {
  if (!Object.hasOwn(update, "programId") && !Object.hasOwn(update, "barangayId")) {
    return;
  }

  const allocationCount = await database.distributionAllocation.count({
    where: { distributionId },
  });
  if (allocationCount > 0) {
    throw new AppError(
      409,
      "DISTRIBUTION_ALLOCATION_SCOPE_LOCKED",
      "Distribution program and barangay cannot change after allocations are created.",
    );
  }
}
