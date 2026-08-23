import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";

export const programCriterionSelect = {
  criterionId: true,
  programId: true,
  criterionName: true,
  fieldName: true,
  operator: true,
  expectedValue: true,
  isRequired: true,
  createdAt: true,
  updatedAt: true,
};

export const programSelect = {
  programId: true,
  programName: true,
  programCode: true,
  programType: true,
  description: true,
  grantAmount: true,
  budgetAmount: true,
  applicationStartDate: true,
  applicationEndDate: true,
  requiredDocumentTypes: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  createdBy: {
    select: {
      userId: true,
      employeeId: true,
      username: true,
      fullName: true,
      role: true,
    },
  },
  criteria: {
    select: programCriterionSelect,
    orderBy: { createdAt: "asc" },
  },
};

export async function getProgramOrThrow(programId, staffUser) {
  const program = await prisma.program.findFirst({
    where: {
      programId,
      ...(staffUser?.role === "BARANGAY_FACILITATOR" ? { status: "ACTIVE" } : {}),
    },
    select: programSelect,
  });

  if (!program) {
    throw new AppError(404, "PROGRAM_NOT_FOUND", "Assistance program was not found.");
  }

  return program;
}

export function assertProgramDraft(program) {
  if (program.status !== "DRAFT") {
    throw new AppError(
      409,
      "PROGRAM_NOT_EDITABLE",
      "Only draft assistance programs and criteria can be edited.",
    );
  }
}

export function assertProgramDetailsValid(program) {
  if (
    program.applicationStartDate
    && program.applicationEndDate
    && program.applicationEndDate < program.applicationStartDate
  ) {
    throw new AppError(
      400,
      "INVALID_APPLICATION_PERIOD",
      "Application end date cannot be earlier than the start date.",
    );
  }

  if (
    program.grantAmount != null
    && program.budgetAmount != null
    && Number(program.grantAmount) > Number(program.budgetAmount)
  ) {
    throw new AppError(
      400,
      "INVALID_PROGRAM_BUDGET",
      "Program budget cannot be lower than the per-beneficiary grant amount.",
    );
  }
}

export function assertProgramTransition(program, nextStatus) {
  const allowedTransitions = {
    DRAFT: ["ACTIVE", "CANCELLED"],
    ACTIVE: ["CLOSED", "CANCELLED"],
    CLOSED: [],
    CANCELLED: [],
  };

  if (!allowedTransitions[program.status]?.includes(nextStatus)) {
    throw new AppError(
      409,
      "INVALID_PROGRAM_TRANSITION",
      `Program cannot transition from ${program.status} to ${nextStatus}.`,
    );
  }
}
