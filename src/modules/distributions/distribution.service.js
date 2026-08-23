import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { distributionAccessWhere } from "./distribution.policy.js";

export const distributionSelect = {
  distributionId: true,
  programId: true,
  createdById: true,
  title: true,
  distributionDate: true,
  startTime: true,
  endTime: true,
  slotDurationMinutes: true,
  location: true,
  barangayId: true,
  status: true,
  verificationRequirement: true,
  createdAt: true,
  updatedAt: true,
  program: {
    select: {
      programId: true,
      programName: true,
      programCode: true,
      programType: true,
      status: true,
    },
  },
  barangay: {
    select: {
      barangayId: true,
      barangayCode: true,
      barangayName: true,
      city: true,
      province: true,
      isActive: true,
    },
  },
  createdBy: {
    select: {
      userId: true,
      employeeId: true,
      username: true,
      fullName: true,
      role: true,
    },
  },
};

function timeMinutes(value) {
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}

function currentPhilippineDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(`${values.year}-${values.month}-${values.day}T00:00:00.000Z`);
}

export function distributionToResponse(distribution) {
  return {
    ...distribution,
    distributionDate: distribution.distributionDate.toISOString().slice(0, 10),
    startTime: distribution.startTime.toISOString().slice(11, 16),
    endTime: distribution.endTime.toISOString().slice(11, 16),
  };
}

export function assertDistributionConfigurationValid(distribution, now = new Date()) {
  if (distribution.distributionDate < currentPhilippineDate(now)) {
    throw new AppError(
      400,
      "DISTRIBUTION_DATE_IN_PAST",
      "Distribution date cannot be earlier than today.",
    );
  }

  const startMinutes = timeMinutes(distribution.startTime);
  const endMinutes = timeMinutes(distribution.endTime);
  if (startMinutes >= endMinutes) {
    throw new AppError(
      400,
      "INVALID_DISTRIBUTION_TIME_RANGE",
      "Distribution end time must be later than the start time.",
    );
  }

  if (distribution.slotDurationMinutes > endMinutes - startMinutes) {
    throw new AppError(
      400,
      "INVALID_SLOT_DURATION",
      "Slot duration must fit within the distribution event time range.",
    );
  }

  if ((endMinutes - startMinutes) % distribution.slotDurationMinutes !== 0) {
    throw new AppError(
      400,
      "DISTRIBUTION_SLOT_INTERVAL_UNEVEN",
      "Distribution time range must divide evenly by the configured slot duration.",
    );
  }
}

export function assertDistributionDraft(distribution) {
  if (distribution.status !== "DRAFT") {
    throw new AppError(
      409,
      "DISTRIBUTION_NOT_EDITABLE",
      "Only draft distribution events can be edited.",
    );
  }
}

export function assertDistributionTransition(distribution, nextStatus) {
  const allowedTransitions = {
    DRAFT: ["OPEN", "CANCELLED"],
    OPEN: [],
    CLOSED: [],
    CANCELLED: [],
  };

  if (!allowedTransitions[distribution.status]?.includes(nextStatus)) {
    throw new AppError(
      409,
      "INVALID_DISTRIBUTION_TRANSITION",
      `Distribution event cannot transition from ${distribution.status} to ${nextStatus}.`,
    );
  }
}

export async function assertActiveDistributionProgram(programId, database = prisma) {
  const program = await database.program.findUnique({
    where: { programId },
    select: { programId: true, status: true },
  });

  if (!program) {
    throw new AppError(404, "PROGRAM_NOT_FOUND", "Assistance program was not found.");
  }

  if (program.status !== "ACTIVE") {
    throw new AppError(
      409,
      "PROGRAM_NOT_ACTIVE",
      "Distribution events can only be created for active assistance programs.",
    );
  }
}

export async function assertActiveDistributionBarangay(barangayId, database = prisma) {
  const barangay = await database.barangay.findUnique({
    where: { barangayId },
    select: { barangayId: true, isActive: true },
  });

  if (!barangay) {
    throw new AppError(404, "BARANGAY_NOT_FOUND", "Barangay was not found.");
  }

  if (!barangay.isActive) {
    throw new AppError(
      409,
      "BARANGAY_INACTIVE",
      "Distribution events can only be assigned to active barangays.",
    );
  }
}

export function buildDistributionOverlapWhere({
  distributionId,
  barangayId,
  distributionDate,
  startTime,
  endTime,
}) {
  return {
    ...(distributionId ? { distributionId: { not: distributionId } } : {}),
    barangayId,
    distributionDate,
    status: { not: "CANCELLED" },
    AND: [
      { startTime: { lt: endTime } },
      { endTime: { gt: startTime } },
    ],
  };
}

export async function assertNoDistributionOverlap(distribution, database = prisma) {
  const conflict = await database.distribution.findFirst({
    where: buildDistributionOverlapWhere(distribution),
    select: {
      distributionId: true,
      title: true,
      startTime: true,
      endTime: true,
    },
  });

  if (conflict) {
    throw new AppError(
      409,
      "DISTRIBUTION_TIME_CONFLICT",
      "Another distribution event overlaps this barangay, date, and time range.",
      { conflictingDistributionId: conflict.distributionId },
    );
  }
}

export async function getDistributionOrThrow(distributionId, staffUser) {
  const distribution = await prisma.distribution.findFirst({
    where: {
      distributionId,
      ...distributionAccessWhere(staffUser),
    },
    select: distributionSelect,
  });

  if (!distribution) {
    throw new AppError(404, "DISTRIBUTION_NOT_FOUND", "Distribution event was not found.");
  }

  return distribution;
}
