import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { distributionAccessWhere } from "./distribution.policy.js";

const PHILIPPINE_TIME_ZONE = "Asia/Manila";
const PHILIPPINE_OFFSET = "+08:00";
export const DISTRIBUTION_SCHEDULE_FIELDS = Object.freeze([
  "distributionDate",
  "startTime",
  "endTime",
  "slotDurationMinutes",
]);

export const distributionSlotSelect = {
  slotId: true,
  distributionId: true,
  slotStart: true,
  slotEnd: true,
  capacity: true,
  slotStatus: true,
  createdAt: true,
  updatedAt: true,
};

export const distributionSlotParentSelect = {
  distributionId: true,
  distributionDate: true,
  startTime: true,
  endTime: true,
  slotDurationMinutes: true,
  barangayId: true,
  status: true,
};

function timeMinutes(value) {
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}

function minutesAsTime(minutes) {
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return `${hours}:${minute}`;
}

function philippineInstant(date, minutes) {
  const dateOnly = date.toISOString().slice(0, 10);
  return new Date(`${dateOnly}T${minutesAsTime(minutes)}:00${PHILIPPINE_OFFSET}`);
}

function formatPhilippineInstant(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PHILIPPINE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}:${fields.second}${PHILIPPINE_OFFSET}`;
}

export function distributionSlotToResponse(slot) {
  return {
    ...slot,
    slotStart: formatPhilippineInstant(slot.slotStart),
    slotEnd: formatPhilippineInstant(slot.slotEnd),
  };
}

export function buildDistributionSlotRows(distribution, capacity) {
  const startMinutes = timeMinutes(distribution.startTime);
  const endMinutes = timeMinutes(distribution.endTime);
  const eventMinutes = endMinutes - startMinutes;

  if (eventMinutes % distribution.slotDurationMinutes !== 0) {
    throw new AppError(
      409,
      "DISTRIBUTION_SLOT_INTERVAL_UNEVEN",
      "Distribution time range must divide evenly by the configured slot duration.",
    );
  }

  const slots = [];
  for (
    let slotStartMinutes = startMinutes;
    slotStartMinutes < endMinutes;
    slotStartMinutes += distribution.slotDurationMinutes
  ) {
    slots.push({
      distributionId: distribution.distributionId,
      slotStart: philippineInstant(distribution.distributionDate, slotStartMinutes),
      slotEnd: philippineInstant(
        distribution.distributionDate,
        slotStartMinutes + distribution.slotDurationMinutes,
      ),
      capacity,
      slotStatus: "AVAILABLE",
    });
  }

  return slots;
}

export function assertDistributionSlotsManageable(distribution) {
  if (distribution.status !== "DRAFT") {
    throw new AppError(
      409,
      "DISTRIBUTION_SLOTS_NOT_EDITABLE",
      "Slots can only be managed while the distribution event is in draft status.",
    );
  }
}

export function assertDistributionSlotTransition(slot, nextStatus) {
  const allowedTransitions = {
    AVAILABLE: ["CLOSED"],
    FULL: ["CLOSED"],
    CLOSED: ["AVAILABLE"],
  };

  if (!allowedTransitions[slot.slotStatus]?.includes(nextStatus)) {
    throw new AppError(
      409,
      "INVALID_DISTRIBUTION_SLOT_TRANSITION",
      `Distribution slot cannot transition from ${slot.slotStatus} to ${nextStatus}.`,
    );
  }
}

export async function getDistributionSlotParentOrThrow(
  distributionId,
  staffUser,
  database = prisma,
) {
  const distribution = await database.distribution.findFirst({
    where: {
      distributionId,
      ...distributionAccessWhere(staffUser),
    },
    select: distributionSlotParentSelect,
  });

  if (!distribution) {
    throw new AppError(404, "DISTRIBUTION_NOT_FOUND", "Distribution event was not found.");
  }

  return distribution;
}

export async function getDistributionSlotOrThrow(
  distributionId,
  slotId,
  database = prisma,
) {
  const slot = await database.distributionSlot.findFirst({
    where: { slotId, distributionId },
    select: distributionSlotSelect,
  });

  if (!slot) {
    throw new AppError(404, "DISTRIBUTION_SLOT_NOT_FOUND", "Distribution slot was not found.");
  }

  return slot;
}

export async function assertDistributionScheduleFieldsUnlocked(
  update,
  distributionId,
  database = prisma,
) {
  const changesSchedule = DISTRIBUTION_SCHEDULE_FIELDS.some((field) => (
    Object.hasOwn(update, field)
  ));

  if (!changesSchedule) {
    return;
  }

  const existingSlotCount = await database.distributionSlot.count({
    where: { distributionId },
  });

  if (existingSlotCount > 0) {
    throw new AppError(
      409,
      "DISTRIBUTION_SCHEDULE_LOCKED",
      "Distribution date, time, and slot duration cannot change after slots are generated.",
    );
  }
}
