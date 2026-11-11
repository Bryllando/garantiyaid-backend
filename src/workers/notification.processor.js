import prisma from "../lib/prisma.js";
import { env } from "../config/env.js";
import { publishNotificationLifecycleFromWorker } from "../realtime/notification.relay.js";
import { simulatedSmsProvider } from "../modules/notifications/simulatedSms.provider.js";
import { simgateSmsProvider } from "../modules/notifications/simgateSms.provider.js";
import { acquirePendingNotification, notificationDeliverySelect } from "../modules/notifications/notification.service.js";

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
          action: notification.simulated ? "SIMULATED_NOTIFICATION_PERMANENTLY_FAILED" : "SMS_NOTIFICATION_FAILED",
          entityAffected: "NOTIFICATION",
          recordId: notification.notificationId,
          details: {
            notificationType: notification.notificationType,
            channel: notification.channel,
            errorCode: result.errorCode,
            simulated: notification.simulated,
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
      simulated: notification.simulated,
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
      simulated: true,
      lastErrorCode: true,
      processingToken: true,
      beneficiary: { select: { barangayId: true } },
    },
  });
  if (!notification || notification.status !== "PENDING") return false;
  return recordPermanentFailure(notification, {
    errorCode: !notification.simulated && notification.lastErrorCode === "SIMGATE_SEND_STARTED"
      ? "SIMGATE_DELIVERY_UNCONFIRMED" : "QUEUE_JOB_ATTEMPTS_EXHAUSTED",
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
          action: notification.simulated ? "SIMULATED_NOTIFICATION_MARKED_SENT" : "SMS_GATEWAY_ACCEPTED",
          entityAffected: "NOTIFICATION",
          recordId: notification.notificationId,
          details: {
            notificationType: notification.notificationType,
            channel: notification.channel,
            simulated: notification.simulated,
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
      simulated: notification.simulated,
      realSmsSent: false,
    });
  }
  return updated;
}

export async function processNotificationJob(
  job,
  {
    database = prisma,
    provider,
    now = new Date(),
    publishLifecycle = publishNotificationLifecycleFromWorker,
  } = {},
) {
  const notificationId = job.data?.notificationId;
  if (typeof notificationId !== "string") {
    throw new TypeError("Notification jobs require a notificationId.");
  }
  const notification = await acquirePendingNotification(notificationId, database, now);
  if (!notification) {
    const previous = await database.notification.findUnique({ where: { notificationId }, select: notificationDeliverySelect });
    if (previous?.status === "PENDING" && previous.simulated === false && previous.lastErrorCode === "SIMGATE_SEND_STARTED") {
      await recordPermanentFailure(previous, { errorCode: "SIMGATE_DELIVERY_UNCONFIRMED" }, database, now, publishLifecycle);
      return { outcome: "FAILED", errorCode: "SIMGATE_DELIVERY_UNCONFIRMED", simulated: false, realSmsSent: false };
    }
    return { outcome: "SKIPPED", realSmsSent: false };
  }

  if (!notification.simulated) {
    if (notification.lastErrorCode === "SIMGATE_SEND_STARTED") {
      await recordPermanentFailure(notification, { errorCode: "SIMGATE_DELIVERY_UNCONFIRMED" }, database, now, publishLifecycle);
      return { outcome: "FAILED", errorCode: "SIMGATE_DELIVERY_UNCONFIRMED", simulated: false, realSmsSent: false };
    }
    if (notification.providerMode !== "SIMGATE" || env.smsProviderMode !== "SIMGATE") {
      await recordPermanentFailure(notification, { errorCode: "SMS_PROVIDER_DISABLED" }, database, now, publishLifecycle);
      return { outcome: "FAILED", errorCode: "SMS_PROVIDER_DISABLED", simulated: false, realSmsSent: false };
    }
    // Persist before the external side effect so a crashed/retried job cannot send it twice.
    const started = await database.notification.updateMany({
      where: { notificationId, status: "PENDING", processingToken: notification.processingToken },
      data: { lastErrorCode: "SIMGATE_SEND_STARTED" },
    });
    if (started.count !== 1) return { outcome: "SKIPPED", realSmsSent: false };
  }

  const selectedProvider = provider ?? (notification.simulated ? simulatedSmsProvider : simgateSmsProvider);
  let result = await selectedProvider.send({
    notificationId: notification.notificationId,
    recipient: notification.beneficiary.contactNumber,
    message: notification.message,
  });
  if (result.success && result.simulated !== notification.simulated) {
    result = { success: false, retryable: false, errorCode: "SMS_PROVIDER_RESULT_MISMATCH" };
  }
  if (result.success) {
    const recorded = await recordSuccess(notification, result, database, now, publishLifecycle);
    if (!recorded) return { outcome: "SKIPPED", realSmsSent: false };
    return {
      outcome: notification.simulated ? "SENT_SIMULATED" : "SMS_GATEWAY_ACCEPTED",
      providerReference: result.providerReference,
      simulated: notification.simulated,
      realSmsSent: false,
    };
  }

  const finalAttempt = !result.retryable || job.attemptsMade + 1 >= attemptsAllowed(job);
  if (finalAttempt) {
    await recordPermanentFailure(notification, result, database, now, publishLifecycle);
    return {
      outcome: "FAILED",
      errorCode: result.errorCode,
      simulated: notification.simulated,
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
