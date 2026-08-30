import { randomUUID } from "node:crypto";
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
  sessionId: true,
  sessionLabel: true,
  location: true,
  serviceAreas: true,
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
  location: true,
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

function normalizedServiceArea(value) {
  return value?.trim().toLocaleLowerCase("en-PH") ?? "";
}

export function distributionSlotCoversBeneficiary(slot, beneficiary) {
  return slot.serviceAreas.length === 0 || Boolean(
    normalizedServiceArea(beneficiary.sitioPurok)
    && slot.serviceAreas.some((area) => (
      normalizedServiceArea(area) === normalizedServiceArea(beneficiary.sitioPurok)
    ))
  );
}

export function assertDistributionSlotCoverage(slot, beneficiary) {
  if (!distributionSlotCoversBeneficiary(slot, beneficiary)) {
    throw new AppError(
      409,
      "DISTRIBUTION_SLOT_SERVICE_AREA_MISMATCH",
      "The selected session does not cover the beneficiary's Sitio or Purok.",
      {
        slotId: slot.slotId,
        sitioPurok: beneficiary.sitioPurok ?? null,
        serviceAreas: slot.serviceAreas,
      },
    );
  }
}

function defaultSession(distribution, capacity) {
  return {
    label: "Main session",
    date: distribution.distributionDate,
    startTime: distribution.startTime,
    endTime: distribution.endTime,
    location: distribution.location,
    capacity,
    serviceAreas: [],
  };
}

export function buildDistributionSlotRows(distribution, capacityOrSessions) {
  const sessions = Array.isArray(capacityOrSessions)
    ? capacityOrSessions
    : [defaultSession(distribution, capacityOrSessions)];
  const eventDate = distribution.distributionDate.toISOString().slice(0, 10);
  const firstSessionDate = sessions
    .map((session) => session.date.toISOString().slice(0, 10))
    .sort()[0];
  if (firstSessionDate !== eventDate) {
    throw new AppError(
      409,
      "DISTRIBUTION_FIRST_SESSION_DATE_MISMATCH",
      "The event date must match the first service session date.",
    );
  }

  const coverageModes = new Set(sessions.map((session) => (
    session.serviceAreas.length === 0 ? "WHOLE_BARANGAY" : "BY_SERVICE_AREA"
  )));
  if (coverageModes.size > 1) {
    throw new AppError(
      409,
      "DISTRIBUTION_SESSION_COVERAGE_MIXED",
      "Use either whole-Barangay sessions or Sitio/Purok sessions, not both in one event.",
    );
  }

  const preparedSessions = sessions.map((session) => {
    const startMinutes = timeMinutes(session.startTime);
    const endMinutes = timeMinutes(session.endTime);
    const eventMinutes = endMinutes - startMinutes;

    if (eventMinutes <= 0) {
      throw new AppError(
        409,
        "INVALID_DISTRIBUTION_SESSION_TIME_RANGE",
        "Every service session must end after it starts.",
      );
    }

    if (eventMinutes % distribution.slotDurationMinutes !== 0) {
      throw new AppError(
        409,
        "DISTRIBUTION_SLOT_INTERVAL_UNEVEN",
        "Every service-session time range must divide evenly by the configured slot duration.",
      );
    }

    return {
      ...session,
      sessionId: randomUUID(),
      startMinutes,
      endMinutes,
      startsAt: philippineInstant(session.date, startMinutes),
      endsAt: philippineInstant(session.date, endMinutes),
    };
  }).sort((left, right) => left.startsAt - right.startsAt);

  for (let index = 1; index < preparedSessions.length; index += 1) {
    if (preparedSessions[index].startsAt < preparedSessions[index - 1].endsAt) {
      throw new AppError(
        409,
        "DISTRIBUTION_SESSIONS_OVERLAP",
        "Service sessions for one distribution event cannot overlap.",
      );
    }
  }

  const slots = [];
  for (const session of preparedSessions) {
    for (
      let slotStartMinutes = session.startMinutes;
      slotStartMinutes < session.endMinutes;
      slotStartMinutes += distribution.slotDurationMinutes
    ) {
      // ponytail: session metadata is repeated per slot; normalize when sessions need editing.
      slots.push({
        distributionId: distribution.distributionId,
        sessionId: session.sessionId,
        sessionLabel: session.label,
        location: session.location,
        serviceAreas: session.serviceAreas,
        slotStart: philippineInstant(session.date, slotStartMinutes),
        slotEnd: philippineInstant(
          session.date,
          slotStartMinutes + distribution.slotDurationMinutes,
        ),
        capacity: session.capacity,
        slotStatus: "AVAILABLE",
      });
    }
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
