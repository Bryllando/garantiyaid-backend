import { randomUUID } from "node:crypto";
import prisma from "../lib/prisma.js";
import { env } from "../config/env.js";
import { gmailApiProvider } from "../modules/staffNotifications/gmailApi.provider.js";

export class RetryableStaffEmailError extends Error {
  constructor(code) {
    super("Gmail reported a retryable delivery failure.");
    this.name = "RetryableStaffEmailError";
    this.code = code;
  }
}

function attemptsAllowed(job) {
  return Number(job.opts?.attempts ?? env.notificationMaxAttempts);
}

export function staffEmailDeliveryTargetPath(notification, jobTargetPath) {
  if (notification.notificationType !== "SECURITY_PASSWORD_RESET_REQUESTED") {
    return notification.targetPath;
  }
  return typeof jobTargetPath === "string"
    && /^\/reset-password\?token=[A-Za-z0-9_-]{43,200}$/.test(jobTargetPath)
    ? jobTargetPath
    : null;
}

async function auditDelivery(tx, notification, action, details = {}) {
  await tx.auditLog.create({
    data: {
      userId: null,
      actorType: "SYSTEM",
      action,
      entityAffected: "STAFF_NOTIFICATION",
      recordId: notification.notificationId,
      details: {
        targetUserId: notification.userId,
        notificationType: notification.notificationType,
        provider: notification.emailProviderMode,
        ...details,
      },
    },
  });
}

async function acquireStaffEmail(notificationId, database, now) {
  const processingToken = randomUUID();
  const staleBefore = new Date(now.getTime() - 10 * 60 * 1_000);
  const claimed = await database.staffNotification.updateMany({
    where: {
      notificationId,
      emailStatus: "PENDING",
      OR: [
        { emailProcessingToken: null },
        { emailProcessingStartedAt: { lt: staleBefore } },
      ],
    },
    data: {
      emailProcessingToken: processingToken,
      emailProcessingStartedAt: now,
      emailAttemptCount: { increment: 1 },
    },
  });
  if (claimed.count !== 1) return null;
  return database.staffNotification.findUnique({
    where: { notificationId },
    select: {
      notificationId: true,
      userId: true,
      notificationType: true,
      title: true,
      message: true,
      targetPath: true,
      createdAt: true,
      emailProviderMode: true,
      emailRecipient: true,
      emailStatus: true,
      emailProcessingToken: true,
      user: { select: { fullName: true } },
    },
  });
}

async function recordFailure(notification, errorCode, database, now) {
  return database.$transaction(async (tx) => {
    const transition = await tx.staffNotification.updateMany({
      where: {
        notificationId: notification.notificationId,
        emailStatus: "PENDING",
        emailProcessingToken: notification.emailProcessingToken,
      },
      data: {
        emailStatus: "FAILED",
        emailLastErrorCode: errorCode,
        emailFailedAt: now,
        emailProcessingToken: null,
        emailProcessingStartedAt: null,
      },
    });
    if (transition.count !== 1) return false;
    await auditDelivery(tx, notification, "STAFF_SECURITY_EMAIL_FAILED", { errorCode });
    return true;
  });
}

export async function markExhaustedStaffEmailJob(
  notificationId,
  { database = prisma, now = new Date() } = {},
) {
  const notification = await database.staffNotification.findUnique({
    where: { notificationId },
    select: {
      notificationId: true,
      userId: true,
      notificationType: true,
      emailProviderMode: true,
      emailStatus: true,
      emailProcessingToken: true,
    },
  });
  if (!notification || notification.emailStatus !== "PENDING") return false;
  return recordFailure(notification, "EMAIL_JOB_ATTEMPTS_EXHAUSTED", database, now);
}

export async function processStaffEmailJob(
  job,
  { database = prisma, provider = gmailApiProvider, now = new Date() } = {},
) {
  const notificationId = job.data?.notificationId;
  if (typeof notificationId !== "string") {
    throw new TypeError("Staff email jobs require a notificationId.");
  }
  const notification = await acquireStaffEmail(notificationId, database, now);
  if (!notification) return { outcome: "SKIPPED" };

  const targetPath = staffEmailDeliveryTargetPath(notification, job.data?.deliveryTargetPath);
  if (notification.notificationType === "SECURITY_PASSWORD_RESET_REQUESTED" && !targetPath) {
    await recordFailure(notification, "PASSWORD_RESET_LINK_UNAVAILABLE", database, now);
    return { outcome: "FAILED", errorCode: "PASSWORD_RESET_LINK_UNAVAILABLE" };
  }

  const result = await provider.send({
    notificationId,
    recipient: notification.emailRecipient,
    recipientName: notification.user.fullName,
    subject: notification.title,
    message: notification.message,
    targetPath,
    occurredAt: notification.createdAt,
  });

  if (result.success) {
    const sent = await database.$transaction(async (tx) => {
      const transition = await tx.staffNotification.updateMany({
        where: {
          notificationId,
          emailStatus: "PENDING",
          emailProcessingToken: notification.emailProcessingToken,
        },
        data: {
          emailStatus: "SENT",
          emailProviderReference: result.providerReference,
          emailLastErrorCode: null,
          emailSentAt: now,
          emailFailedAt: null,
          emailProcessingToken: null,
          emailProcessingStartedAt: null,
        },
      });
      if (transition.count !== 1) return false;
      await auditDelivery(tx, notification, "STAFF_SECURITY_EMAIL_SENT");
      return true;
    });
    return sent
      ? { outcome: "SENT", providerReference: result.providerReference }
      : { outcome: "SKIPPED" };
  }

  const finalAttempt = !result.retryable || job.attemptsMade + 1 >= attemptsAllowed(job);
  if (finalAttempt) {
    await recordFailure(notification, result.errorCode, database, now);
    return { outcome: "FAILED", errorCode: result.errorCode };
  }

  await database.staffNotification.updateMany({
    where: {
      notificationId,
      emailStatus: "PENDING",
      emailProcessingToken: notification.emailProcessingToken,
    },
    data: {
      emailLastErrorCode: result.errorCode,
      emailProcessingToken: null,
      emailProcessingStartedAt: null,
    },
  });
  throw new RetryableStaffEmailError(result.errorCode);
}
