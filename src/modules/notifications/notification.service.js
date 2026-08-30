import { createHash, randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { renderNotificationTemplate } from "./notification.templates.js";

const PHILIPPINE_TIME_ZONE = "Asia/Manila";
const PHILIPPINE_OFFSET = "+08:00";

export const notificationPublicSelect = {
  notificationId: true,
  beneficiaryId: true,
  scheduleId: true,
  distributionId: true,
  initiatedById: true,
  channel: true,
  message: true,
  notificationType: true,
  status: true,
  providerMode: true,
  providerReference: true,
  simulated: true,
  attemptCount: true,
  lastErrorCode: true,
  scheduledFor: true,
  sentAt: true,
  failedAt: true,
  createdAt: true,
  updatedAt: true,
  beneficiary: {
    select: {
      contactNumber: true,
      barangayId: true,
    },
  },
  schedule: {
    select: {
      scheduleId: true,
      queueNumber: true,
      status: true,
      slot: {
        select: {
          slotStart: true,
          slotEnd: true,
          sessionLabel: true,
          location: true,
        },
      },
    },
  },
  distribution: {
    select: {
      distributionId: true,
      title: true,
      status: true,
      barangayId: true,
    },
  },
};

export const notificationDeliverySelect = {
  notificationId: true,
  beneficiaryId: true,
  scheduleId: true,
  distributionId: true,
  initiatedById: true,
  channel: true,
  message: true,
  notificationType: true,
  status: true,
  simulated: true,
  processingToken: true,
  beneficiary: { select: { contactNumber: true, barangayId: true } },
};

export const notificationScheduleContextSelect = {
  scheduleId: true,
  beneficiaryId: true,
  distributionId: true,
  queueNumber: true,
  status: true,
  beneficiary: {
    select: {
      beneficiaryId: true,
      barangayId: true,
      contactNumber: true,
      status: true,
    },
  },
  slot: {
    select: {
      slotStart: true,
      slotEnd: true,
      sessionLabel: true,
      location: true,
    },
  },
  distribution: {
    select: {
      distributionId: true,
      title: true,
      location: true,
      status: true,
      barangayId: true,
    },
  },
  claim: {
    select: { claimStatus: true },
  },
};

function philippineTimestamp(value) {
  if (!value) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PHILIPPINE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}:${fields.second}.${fields.fractionalSecond}${PHILIPPINE_OFFSET}`;
}

export function maskRecipient(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return `${"*".repeat(Math.min(8, digits.length - 4))}${digits.slice(-4)}`;
}

export function notificationToResponse(notification) {
  const { beneficiary, processingToken, ...publicFields } = notification;
  return {
    ...publicFields,
    providerReference: notification.providerReference ?? null,
    recipientMasked: maskRecipient(beneficiary?.contactNumber),
    barangayId: beneficiary?.barangayId ?? notification.distribution?.barangayId ?? null,
    scheduledFor: philippineTimestamp(notification.scheduledFor),
    sentAt: philippineTimestamp(notification.sentAt),
    failedAt: philippineTimestamp(notification.failedAt),
    createdAt: philippineTimestamp(notification.createdAt),
    updatedAt: philippineTimestamp(notification.updatedAt),
    simulationDisclosure: "Simulation only; no real SMS was sent.",
  };
}

export function buildNotificationWhere(filters, barangayId) {
  return {
    ...(filters.beneficiaryId ? { beneficiaryId: filters.beneficiaryId } : {}),
    ...(filters.distributionId ? { distributionId: filters.distributionId } : {}),
    ...(filters.scheduleId ? { scheduleId: filters.scheduleId } : {}),
    ...(filters.channel ? { channel: filters.channel } : {}),
    ...(filters.notificationType ? { notificationType: filters.notificationType } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.dateFrom || filters.dateTo ? {
      createdAt: {
        ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
        ...(filters.dateTo ? { lte: filters.dateTo } : {}),
      },
    } : {}),
    ...(barangayId ? { beneficiary: { is: { barangayId } } } : {}),
  };
}

export function notificationDeduplicationKey({ scheduleId, notificationType, message, scheduledFor }) {
  return createHash("sha256").update(JSON.stringify({
    scheduleId,
    notificationType,
    message,
    scheduledFor: scheduledFor?.toISOString() ?? null,
  })).digest("hex");
}

export function notificationScheduledFor(notificationType, requestedSendAt, slotStart, now = new Date()) {
  if (notificationType !== "DISTRIBUTION_REMINDER") return now;
  const computed = requestedSendAt ?? new Date(
    slotStart.getTime() - env.distributionReminderLeadMinutes * 60 * 1_000,
  );
  if (computed > slotStart) {
    throw new AppError(400, "NOTIFICATION_DELAY_INVALID", "A reminder must run no later than its schedule time.");
  }
  if (computed.getTime() - now.getTime() > env.notificationMaxDelayDays * 86_400_000) {
    throw new AppError(400, "NOTIFICATION_DELAY_TOO_LONG", "The delayed reminder exceeds the configured maximum delay.");
  }
  return computed > now ? computed : now;
}

export function assertNotificationLifecycle(schedule, notificationType) {
  if (schedule.beneficiary.status !== "ACTIVE") {
    throw new AppError(409, "NOTIFICATION_BENEFICIARY_INACTIVE", "Notifications require an active beneficiary.");
  }
  if (notificationType === "SCHEDULE_CANCELLED" && schedule.status !== "CANCELLED") {
    throw new AppError(409, "NOTIFICATION_LIFECYCLE_INVALID", "A cancellation notice requires a cancelled schedule.");
  }
  if (
    ["SCHEDULE_CREATED", "SCHEDULE_UPDATED", "DISTRIBUTION_OPENED", "DISTRIBUTION_REMINDER"].includes(notificationType)
    && schedule.status !== "SCHEDULED"
  ) {
    throw new AppError(409, "NOTIFICATION_LIFECYCLE_INVALID", "This notification requires an active scheduled assignment.");
  }
  if (notificationType === "DISTRIBUTION_OPENED" && schedule.distribution.status !== "OPEN") {
    throw new AppError(409, "NOTIFICATION_LIFECYCLE_INVALID", "The distribution must be open before sending an opening notice.");
  }
  if (
    notificationType === "CLAIM_VERIFIED"
    && !["VERIFIED", "CLAIMED"].includes(schedule.claim?.claimStatus)
  ) {
    throw new AppError(409, "NOTIFICATION_LIFECYCLE_INVALID", "A verified-claim notice requires a verified or claimed record.");
  }
  if (notificationType === "BENEFIT_CREDITED_SIMULATED" && schedule.claim?.claimStatus !== "CLAIMED") {
    throw new AppError(409, "NOTIFICATION_LIFECYCLE_INVALID", "A simulated-credit notice requires a claimed record.");
  }
}

export function notificationRowFromSchedule(
  schedule,
  { notificationType, sendAt, initiatedById, now = new Date() },
) {
  assertNotificationLifecycle(schedule, notificationType);
  const scheduledFor = notificationScheduledFor(
    notificationType,
    sendAt,
    schedule.slot.slotStart,
    now,
  );
  const message = renderNotificationTemplate(notificationType, {
    distributionTitle: schedule.distribution.title,
    location: schedule.slot.location ?? schedule.distribution.location,
    slotStart: schedule.slot.slotStart,
    queueNumber: schedule.queueNumber,
  });
  return {
    beneficiaryId: schedule.beneficiaryId,
    scheduleId: schedule.scheduleId,
    distributionId: schedule.distributionId,
    initiatedById,
    channel: "SMS",
    message,
    notificationType,
    status: "PENDING",
    providerMode: "SIMULATED",
    simulated: true,
    scheduledFor,
    deduplicationKey: notificationDeduplicationKey({
      scheduleId: schedule.scheduleId,
      notificationType,
      message,
      scheduledFor: notificationType === "DISTRIBUTION_REMINDER" ? scheduledFor : null,
    }),
  };
}

export async function createNotificationRows(rows, database = prisma) {
  const notifications = [];
  const newlyCreated = [];
  for (const row of rows) {
    let notification = await database.notification.findUnique({
      where: { deduplicationKey: row.deduplicationKey },
      select: notificationPublicSelect,
    });
    if (!notification) {
      try {
        notification = await database.notification.create({
          data: row,
          select: notificationPublicSelect,
        });
        newlyCreated.push(notification);
      } catch (error) {
        if (error.code !== "P2002") throw error;
        notification = await database.notification.findUnique({
          where: { deduplicationKey: row.deduplicationKey },
          select: notificationPublicSelect,
        });
      }
    }
    notifications.push(notification);
  }
  return { notifications, newlyCreated };
}

export async function getNotificationOrThrow(notificationId, barangayId, database = prisma) {
  const notification = await database.notification.findFirst({
    where: {
      notificationId,
      ...(barangayId ? { beneficiary: { is: { barangayId } } } : {}),
    },
    select: notificationPublicSelect,
  });
  if (!notification) {
    throw new AppError(404, "NOTIFICATION_NOT_FOUND", "Notification was not found.");
  }
  return notification;
}

export async function acquirePendingNotification(notificationId, database = prisma, now = new Date()) {
  const processingToken = randomUUID();
  const staleBefore = new Date(now.getTime() - 10 * 60 * 1_000);
  const claimed = await database.notification.updateMany({
    where: {
      notificationId,
      status: "PENDING",
      OR: [
        { processingToken: null },
        { processingStartedAt: { lt: staleBefore } },
      ],
    },
    data: {
      processingToken,
      processingStartedAt: now,
      attemptCount: { increment: 1 },
    },
  });
  if (claimed.count !== 1) return null;
  return database.notification.findUnique({
    where: { notificationId },
    select: notificationDeliverySelect,
  });
}

export function assertNotificationRetryable(notification) {
  if (notification.status !== "FAILED") {
    throw new AppError(409, "NOTIFICATION_NOT_RETRYABLE", "Only a failed notification may be manually retried.");
  }
}
