import prisma from "../lib/prisma.js";
import { env } from "../config/env.js";
import { publishNotificationLifecycleFromWorker } from "../realtime/notification.relay.js";
import { simulatedSmsProvider } from "../modules/notifications/simulatedSms.provider.js";
import { acquirePendingNotification } from "../modules/notifications/notification.service.js";

const SCHEDULE_NOTICE_TYPES = new Set([
  "SCHEDULE_CREATED",
  "SCHEDULE_UPDATED",
  "SCHEDULE_CANCELLED",
  "DISTRIBUTION_OPENED",
  "DISTRIBUTION_REMINDER",
]);

export class RetryableSimulatedSmsError extends Error {
  constructor(code) {
    super("The simulated SMS provider reported a retryable failure.");
    this.name = "RetryableSimulatedSmsError";
    this.code = code;
  }
}

function attemptsAllowed(job) {
  return Number(job.opts?.attempts ?? env.notificationMaxAttempts);
}

async function recordPermanentFailure(notification, result, database, now, publishLifecycle) {
  const updated = await database.$transaction(async (tx) => {
    const transition = await tx.notification.updateMany({
      where: {
        notificationId: notification.notificationId,
        status: "PENDING",
        processingToken: notification.processingToken,
      },
      data: {
        status: "FAILED",
        failedAt: now,
        sentAt: null,
        providerReference: null,
        lastErrorCode: result.errorCode,
        processingToken: null,
        processingStartedAt: null,
      },
    });
    if (transition.count !== 1) return false;
    if (notification.initiatedById) {
      await tx.auditLog.create({
        data: {
          userId: notification.initiatedById,
          action: "SIMULATED_NOTIFICATION_PERMANENTLY_FAILED",
          entityAffected: "NOTIFICATION",
          recordId: notification.notificationId,
          details: {
            notificationType: notification.notificationType,
            channel: notification.channel,
            errorCode: result.errorCode,
            simulated: true,
            realSmsSent: false,
          },
        },
      });
    }
    return true;
  });
  if (updated) {
    await publishLifecycle("notification.failed", notification, {
      status: "FAILED",
      errorCode: result.errorCode,
      simulated: true,
      realSmsSent: false,
    });
  }
  return updated;
}

export async function markExhaustedNotificationJob(
  notificationId,
  {
    database = prisma,
    now = new Date(),
    publishLifecycle = publishNotificationLifecycleFromWorker,
  } = {},
) {
  const notification = await database.notification.findUnique({
    where: { notificationId },
    select: {
      notificationId: true,
      beneficiaryId: true,
      scheduleId: true,
      distributionId: true,
      initiatedById: true,
      channel: true,
      notificationType: true,
      status: true,
      processingToken: true,
      beneficiary: { select: { barangayId: true } },
    },
  });
  if (!notification || notification.status !== "PENDING") return false;
  return recordPermanentFailure(notification, {
    errorCode: "QUEUE_JOB_ATTEMPTS_EXHAUSTED",
  }, database, now, publishLifecycle);
}

async function recordSuccess(notification, result, database, now, publishLifecycle) {
  const updated = await database.$transaction(async (tx) => {
    const transition = await tx.notification.updateMany({
      where: {
        notificationId: notification.notificationId,
        status: "PENDING",
        processingToken: notification.processingToken,
      },
      data: {
        status: "SENT",
        sentAt: now,
        failedAt: null,
        providerReference: result.providerReference,
        lastErrorCode: null,
        processingToken: null,
        processingStartedAt: null,
      },
    });
    if (transition.count !== 1) return false;
    if (notification.scheduleId && SCHEDULE_NOTICE_TYPES.has(notification.notificationType)) {
      await tx.schedule.updateMany({
        where: { scheduleId: notification.scheduleId },
        data: { notificationAt: now },
      });
    }
    if (notification.initiatedById) {
      await tx.auditLog.create({
        data: {
          userId: notification.initiatedById,
          action: "SIMULATED_NOTIFICATION_MARKED_SENT",
          entityAffected: "NOTIFICATION",
          recordId: notification.notificationId,
          details: {
            notificationType: notification.notificationType,
            channel: notification.channel,
            simulated: true,
            realSmsSent: false,
          },
        },
      });
    }
    return true;
  });
  if (updated) {
    await publishLifecycle("notification.sent", notification, {
      status: "SENT",
      simulated: true,
      realSmsSent: false,
    });
  }
  return updated;
}

export async function processNotificationJob(
  job,
  {
    database = prisma,
    provider = simulatedSmsProvider,
    now = new Date(),
    publishLifecycle = publishNotificationLifecycleFromWorker,
  } = {},
) {
  const notificationId = job.data?.notificationId;
  if (typeof notificationId !== "string") {
    throw new TypeError("Notification jobs require a notificationId.");
  }
  const notification = await acquirePendingNotification(notificationId, database, now);
  if (!notification) return { outcome: "SKIPPED", simulated: true, realSmsSent: false };

  const result = await provider.send({
    notificationId: notification.notificationId,
    recipient: notification.beneficiary.contactNumber,
    message: notification.message,
  });
  if (result.success) {
    await recordSuccess(notification, result, database, now, publishLifecycle);
    return {
      outcome: "SENT_SIMULATED",
      providerReference: result.providerReference,
      simulated: true,
      realSmsSent: false,
    };
  }

  const finalAttempt = !result.retryable || job.attemptsMade + 1 >= attemptsAllowed(job);
  if (finalAttempt) {
    await recordPermanentFailure(notification, result, database, now, publishLifecycle);
    return {
      outcome: "FAILED",
      errorCode: result.errorCode,
      simulated: true,
      realSmsSent: false,
    };
  }

  await database.notification.updateMany({
    where: {
      notificationId,
      status: "PENDING",
      processingToken: notification.processingToken,
    },
    data: {
      lastErrorCode: result.errorCode,
      processingToken: null,
      processingStartedAt: null,
    },
  });
  throw new RetryableSimulatedSmsError(result.errorCode);
}
