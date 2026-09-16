import prisma from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { enqueueNotificationJobs, notificationQueueHealth } from "../../queues/notification.queue.js";
import { publishNotificationLifecycle } from "../../realtime/publishers.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { prepareAssistantApproval, executeAssistantApproval } from "../../utils/assistantApproval.js";
import {
  assertIdempotencyRequestMatches,
  findIdempotencyRecord,
  idempotencyRequestHash,
  requireIdempotencyKey,
  saveIdempotencyRecord,
} from "../../utils/idempotency.js";
import {
  assertNotificationBarangayAccess,
  assertNotificationReadAllowed,
  assertNotificationRetryAllowed,
  assertNotificationTypeAllowed,
  resolveNotificationBarangay,
} from "./notification.policy.js";
import {
  buildNotificationWhere,
  assertNotificationRetryable,
  createNotificationRows,
  getNotificationOrThrow,
  notificationPublicSelect,
  notificationRowFromSchedule,
  notificationScheduleContextSelect,
  notificationToResponse,
  assistantReminderPreviewFromSchedules,
} from "./notification.service.js";

async function assertFilterScope(staffUser, filters) {
  if (staffUser.role !== "BARANGAY_FACILITATOR") return;
  const lookups = [];
  if (filters.beneficiaryId) {
    lookups.push(prisma.beneficiary.findUnique({
      where: { beneficiaryId: filters.beneficiaryId },
      select: { barangayId: true },
    }));
  }
  if (filters.distributionId) {
    lookups.push(prisma.distribution.findUnique({
      where: { distributionId: filters.distributionId },
      select: { barangayId: true },
    }));
  }
  if (filters.scheduleId) {
    lookups.push(prisma.schedule.findUnique({
      where: { scheduleId: filters.scheduleId },
      select: { beneficiary: { select: { barangayId: true } } },
    }));
  }
  const targets = await Promise.all(lookups);
  for (const target of targets) {
    const barangayId = target?.barangayId ?? target?.beneficiary?.barangayId;
    if (barangayId) assertNotificationBarangayAccess(staffUser, barangayId);
  }
}

async function notificationListResponse(req, filters) {
  assertNotificationReadAllowed(req.staffUser);
  await assertFilterScope(req.staffUser, filters);
  const barangayId = resolveNotificationBarangay(req.staffUser);
  const { page, pageSize, ...whereFilters } = filters;
  const where = buildNotificationWhere(whereFilters, barangayId);
  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      select: notificationPublicSelect,
      orderBy: [{ createdAt: "desc" }, { notificationId: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.notification.count({ where }),
  ]);
  return {
    notifications: notifications.map(notificationToResponse),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    simulatedSmsOnly: true,
  };
}

export const listNotifications = asyncHandler(async (req, res) => {
  res.status(200).json({
    success: true,
    data: await notificationListResponse(req, req.validatedQuery),
  });
});

export const listDistributionNotifications = asyncHandler(async (req, res) => {
  const distribution = await prisma.distribution.findUnique({
    where: { distributionId: req.validatedParams.distributionId },
    select: { barangayId: true },
  });
  if (!distribution) {
    throw new AppError(404, "DISTRIBUTION_NOT_FOUND", "Distribution event was not found.");
  }
  assertNotificationBarangayAccess(req.staffUser, distribution.barangayId);
  res.status(200).json({
    success: true,
    data: await notificationListResponse(req, {
      ...req.validatedQuery,
      distributionId: req.validatedParams.distributionId,
    }),
  });
});

export const summarizeNotifications = asyncHandler(async (req, res) => {
  assertNotificationReadAllowed(req.staffUser);
  await assertFilterScope(req.staffUser, req.validatedQuery);
  const barangayId = resolveNotificationBarangay(req.staffUser);
  const where = buildNotificationWhere(req.validatedQuery, barangayId);
  const [total, byStatus, byType, byChannel] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.groupBy({ by: ["status"], where, _count: { _all: true }, orderBy: { status: "asc" } }),
    prisma.notification.groupBy({ by: ["notificationType"], where, _count: { _all: true }, orderBy: { notificationType: "asc" } }),
    prisma.notification.groupBy({ by: ["channel"], where, _count: { _all: true }, orderBy: { channel: "asc" } }),
  ]);
  const asCounts = (rows, key) => Object.fromEntries(
    rows.map((row) => [row[key], row._count._all]),
  );
  res.status(200).json({
    success: true,
    data: {
      total,
      byStatus: asCounts(byStatus, "status"),
      byType: asCounts(byType, "notificationType"),
      byChannel: asCounts(byChannel, "channel"),
      simulatedSmsOnly: true,
    },
  });
});

export const getNotification = asyncHandler(async (req, res) => {
  assertNotificationReadAllowed(req.staffUser);
  const notification = await getNotificationOrThrow(req.validatedParams.notificationId, null);
  assertNotificationBarangayAccess(req.staffUser, notification.beneficiary.barangayId);
  res.status(200).json({
    success: true,
    data: { notification: notificationToResponse(notification) },
  });
});

async function existingIdempotentResponse(identity, requestHash) {
  const existing = await findIdempotencyRecord(identity);
  if (!existing) return null;
  assertIdempotencyRequestMatches(existing, requestHash);
  return existing;
}

async function sendIdempotentResponse(res, result, replayed) {
  res.set("Idempotency-Replayed", String(replayed));
  return res.status(result.responseStatus).json(result.responseBody);
}

async function enqueueRows(req, operation, schedules, options = {}) {
  const notificationType = options.notificationType ?? req.validatedBody.notificationType;
  assertNotificationTypeAllowed(req.staffUser, notificationType);
  const idempotencyKey = requireIdempotencyKey(req, "notification enqueueing");
  const identity = { userId: req.auth.userId, operation, idempotencyKey };
  const requestHash = idempotencyRequestHash({
    params: req.validatedParams,
    body: req.validatedBody,
  });
  const replay = await existingIdempotentResponse(identity, requestHash);
  if (replay) return { replay };

  const now = new Date();
  const rows = schedules.map((schedule) => notificationRowFromSchedule(schedule, {
    notificationType,
    sendAt: req.validatedBody.sendAt ?? (options.assistant ? now : undefined),
    initiatedById: req.auth.userId,
    messageTemplate: options.messageTemplate,
    now,
  }));
  const { notifications, newlyCreated } = await createNotificationRows(rows);
  const pending = notifications.filter((notification) => notification.status === "PENDING");
  try {
    await enqueueNotificationJobs(pending, { now });
  } catch {
    throw new AppError(
      503,
      "NOTIFICATION_QUEUE_UNAVAILABLE",
      "The notification row was recorded, but Redis queueing is unavailable. Retry with the same Idempotency-Key.",
      { recordedNotificationCount: notifications.length, simulated: true, realSmsSent: false },
    );
  }

  const responseBody = {
    success: true,
    data: {
      notifications: notifications.map(notificationToResponse),
      queuedCount: pending.length,
      deduplicatedCount: notifications.length - newlyCreated.length,
      simulated: true,
      realSmsSent: false,
      message: "Notifications were queued for simulated SMS processing; no real SMS has been sent.",
    },
  };
  const responseStatus = 202;
  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: operation.startsWith("NOTIFICATION_ENQUEUE_DISTRIBUTION:")
          ? "NOTIFICATION_BATCH_ENQUEUED"
          : "SCHEDULE_NOTIFICATION_ENQUEUED",
        entityAffected: operation.startsWith("NOTIFICATION_ENQUEUE_DISTRIBUTION:")
          ? "DISTRIBUTION"
          : "SCHEDULE",
        recordId: operation.startsWith("NOTIFICATION_ENQUEUE_DISTRIBUTION:")
          ? schedules[0].distributionId
          : schedules[0].scheduleId,
        ipAddress: clientIpAddress(req),
        details: {
          notificationType,
          requestedCount: schedules.length,
          queuedCount: pending.length,
          ...(options.assistant ? {
            assistant: true,
            serviceArea: req.validatedBody.serviceArea ?? null,
          } : {}),
          simulated: true,
          realSmsSent: false,
        },
      },
    });
    await saveIdempotencyRecord({ identity, requestHash, responseStatus, responseBody, now }, tx);
  });
  await Promise.all(pending.map((notification) => publishNotificationLifecycle(
    "notification.queued",
    notification,
    { status: "PENDING", simulated: true, realSmsSent: false },
  )));
  return { responseStatus, responseBody };
}

async function assistantReminderContext(req, database = prisma) {
  const { distributionId } = req.validatedParams;
  const distribution = await database.distribution.findUnique({
    where: { distributionId },
    select: {
      distributionId: true,
      title: true,
      distributionDate: true,
      location: true,
      status: true,
      barangayId: true,
      barangay: { select: { barangayName: true } },
    },
  });
  if (!distribution) throw new AppError(404, "DISTRIBUTION_NOT_FOUND", "Distribution event was not found.");
  assertNotificationBarangayAccess(req.staffUser, distribution.barangayId);

  const schedules = await database.schedule.findMany({
    where: {
      distributionId,
      status: "SCHEDULED",
      beneficiary: {
        is: {
          status: "ACTIVE",
          ...(req.validatedBody.serviceArea ? {
            sitioPurok: { equals: req.validatedBody.serviceArea, mode: "insensitive" },
          } : {}),
        },
      },
    },
    select: notificationScheduleContextSelect,
    orderBy: [{ slot: { slotStart: "asc" } }, { queueNumber: "asc" }],
    take: env.notificationBatchMaxSize + 1,
  });
  if (schedules.length > env.notificationBatchMaxSize) {
    throw new AppError(
      413,
      "NOTIFICATION_BATCH_TOO_LARGE",
      `An assistant reminder may contain at most ${env.notificationBatchMaxSize} scheduled beneficiaries.`,
    );
  }

  const preview = assistantReminderPreviewFromSchedules(schedules, {
    messageTemplate: req.validatedBody.messageTemplate,
    sendAt: req.validatedBody.sendAt,
    initiatedById: req.auth.userId,
  });
  return { distribution, ...preview };
}

export const previewAssistantDistributionReminder = asyncHandler(async (req, res) => {
  const { schedules, ...preview } = await assistantReminderContext(req);
  const approval = await prepareAssistantApproval(req.auth.userId, `ASSISTANT_REMINDER:${req.validatedParams.distributionId}`, {
    ...req.validatedBody, expectedRecipientCount: preview.recipientCount, expectedPreviewHash: preview.previewHash,
  }, {
    recipientCount: preview.recipientCount, previewHash: preview.previewHash,
  });
  res.status(200).json({
    success: true,
    data: {
      ...preview,
      ...approval,
      simulatedSmsOnly: true,
      claimAuthorizationDisclosure: "An SMS notice is not proof of eligibility. Claim authorization still requires the official schedule and identity verification.",
    },
  });
});

export const enqueueAssistantDistributionReminder = asyncHandler(async (req, res) => {
  assertNotificationTypeAllowed(req.staffUser, "DISTRIBUTION_REMINDER");
  const { approvalId, confirmed, expectedRecipientCount, expectedPreviewHash, ...payload } = req.validatedBody;
  // Recheck the event scope before replay as well as inside the write transaction.
  const event = await prisma.distribution.findUnique({ where: { distributionId: req.validatedParams.distributionId }, select: { barangayId: true } });
  if (!event) throw new AppError(404, "DISTRIBUTION_NOT_FOUND", "Distribution event was not found.");
  assertNotificationBarangayAccess(req.staffUser, event.barangayId);
  const result = await executeAssistantApproval(req, `ASSISTANT_REMINDER:${req.validatedParams.distributionId}`, { ...payload, expectedRecipientCount, expectedPreviewHash }, async (tx, approved) => {
    const preview = await assistantReminderContext(req, tx);
    if (preview.recipientCount === 0) {
      throw new AppError(409, "NOTIFICATION_BATCH_EMPTY", "No scheduled beneficiaries with valid mobile numbers match this reminder.");
    }
    if (preview.recipientCount !== expectedRecipientCount || preview.recipientCount !== approved.recipientCount) {
      throw new AppError(
        409,
        "NOTIFICATION_PREVIEW_CHANGED",
        "The recipient list changed after preview. Review the updated recipients before confirming again.",
        { expectedRecipientCount: req.validatedBody.expectedRecipientCount, actualRecipientCount: preview.recipientCount },
      );
    }
    if (preview.previewHash !== expectedPreviewHash || preview.previewHash !== approved.previewHash) {
      throw new AppError(
        409,
        "NOTIFICATION_PREVIEW_CHANGED",
        "The recipient details changed after preview. Review the updated recipients before confirming again.",
      );
    }

    const now = new Date();
    if (payload.sendAt && payload.sendAt <= now) throw new AppError(409, "ASSISTANT_SCHEDULE_PASSED", "The queue time has passed. Choose a new time and review again.");
    const rows = preview.schedules.map((schedule) => notificationRowFromSchedule(schedule, {
      notificationType: "DISTRIBUTION_REMINDER", messageTemplate: payload.messageTemplate,
      sendAt: payload.sendAt ?? now, initiatedById: req.auth.userId, now,
    }));
    const { notifications, newlyCreated } = await createNotificationRows(rows, tx);
    await tx.auditLog.create({ data: {
      userId: req.auth.userId, action: "NOTIFICATION_BATCH_ENQUEUED", entityAffected: "DISTRIBUTION",
      recordId: req.validatedParams.distributionId, ipAddress: clientIpAddress(req),
      details: { assistant: true, approvalId, requestedCount: rows.length, simulated: true, realSmsSent: false },
    } });
    return { responseStatus: 202, responseBody: { success: true, data: {
      notifications: notifications.map(notificationToResponse), queuedCount: notifications.filter((row) => row.status === "PENDING").length,
      deduplicatedCount: notifications.length - newlyCreated.length,
      simulated: true, realSmsSent: false,
    } } };
  });
  const pending = await prisma.notification.findMany({ where: {
    notificationId: { in: result.responseBody.data.notifications.map((row) => row.notificationId) }, status: "PENDING",
  }, select: notificationPublicSelect });
  try {
    if (pending.length) await enqueueNotificationJobs(pending);
  } catch {
    throw new AppError(503, "NOTIFICATION_QUEUE_UNAVAILABLE", "The reminders were recorded. Retry this same approval to finish queueing without creating duplicates.");
  }
  if (!result.replayed) await Promise.all(pending.map((notification) => publishNotificationLifecycle("notification.queued", notification, { status: "PENDING", simulated: true, realSmsSent: false })));
  res.set("Idempotency-Replayed", String(result.replayed));
  return res.status(result.responseStatus).json(result.responseBody);
});

export const enqueueScheduleNotification = asyncHandler(async (req, res) => {
  const schedule = await prisma.schedule.findUnique({
    where: { scheduleId: req.validatedParams.scheduleId },
    select: notificationScheduleContextSelect,
  });
  if (!schedule) throw new AppError(404, "DISTRIBUTION_SCHEDULE_NOT_FOUND", "Distribution schedule was not found.");
  assertNotificationBarangayAccess(req.staffUser, schedule.beneficiary.barangayId);
  const result = await enqueueRows(
    req,
    `NOTIFICATION_ENQUEUE_SCHEDULE:${schedule.scheduleId}`,
    [schedule],
  );
  if (result.replay) return sendIdempotentResponse(res, result.replay, true);
  return sendIdempotentResponse(res, result, false);
});

export const enqueueDistributionNotifications = asyncHandler(async (req, res) => {
  const { distributionId } = req.validatedParams;
  const distribution = await prisma.distribution.findUnique({
    where: { distributionId },
    select: { distributionId: true, barangayId: true },
  });
  if (!distribution) throw new AppError(404, "DISTRIBUTION_NOT_FOUND", "Distribution event was not found.");
  assertNotificationBarangayAccess(req.staffUser, distribution.barangayId);

  const requestedIds = req.validatedBody.scheduleIds;
  const schedules = await prisma.schedule.findMany({
    where: {
      distributionId,
      ...(requestedIds ? { scheduleId: { in: requestedIds } } : {}),
    },
    select: notificationScheduleContextSelect,
    orderBy: { scheduleId: "asc" },
    take: env.notificationBatchMaxSize + 1,
  });
  if (requestedIds && schedules.length !== requestedIds.length) {
    throw new AppError(404, "DISTRIBUTION_SCHEDULE_NOT_FOUND", "One or more distribution schedules were not found.");
  }
  if (schedules.length === 0) {
    throw new AppError(409, "NOTIFICATION_BATCH_EMPTY", "No schedules are available for notification.");
  }
  if (schedules.length > env.notificationBatchMaxSize) {
    throw new AppError(413, "NOTIFICATION_BATCH_TOO_LARGE", `A notification batch may contain at most ${env.notificationBatchMaxSize} schedules.`);
  }
  const result = await enqueueRows(
    req,
    `NOTIFICATION_ENQUEUE_DISTRIBUTION:${distributionId}`,
    schedules,
  );
  if (result.replay) return sendIdempotentResponse(res, result.replay, true);
  return sendIdempotentResponse(res, result, false);
});

export const retryNotification = asyncHandler(async (req, res) => {
  assertNotificationRetryAllowed(req.staffUser);
  const { notificationId } = req.validatedParams;
  const idempotencyKey = requireIdempotencyKey(req, "notification retrying");
  const operation = `NOTIFICATION_RETRY:${notificationId}`;
  const identity = { userId: req.auth.userId, operation, idempotencyKey };
  const requestHash = idempotencyRequestHash({ notificationId });
  const replay = await existingIdempotentResponse(identity, requestHash);
  if (replay) return sendIdempotentResponse(res, replay, true);

  const notification = await getNotificationOrThrow(notificationId, null);
  assertNotificationRetryable(notification);
  const transitioned = await prisma.notification.updateMany({
    where: { notificationId, status: "FAILED" },
    data: {
      status: "PENDING",
      attemptCount: 0,
      lastErrorCode: null,
      providerReference: null,
      failedAt: null,
      sentAt: null,
      scheduledFor: new Date(),
      processingToken: null,
      processingStartedAt: null,
    },
  });
  if (transitioned.count !== 1) {
    throw new AppError(409, "NOTIFICATION_CONCURRENT_CHANGE", "The notification changed concurrently.");
  }
  try {
    await enqueueNotificationJobs([{ notificationId, scheduledFor: new Date() }]);
  } catch {
    await prisma.notification.updateMany({
      where: { notificationId, status: "PENDING" },
      data: { status: "FAILED", failedAt: new Date(), lastErrorCode: "QUEUE_UNAVAILABLE" },
    });
    throw new AppError(503, "NOTIFICATION_QUEUE_UNAVAILABLE", "Redis queueing is unavailable. The notification remains failed.");
  }
  const updated = await getNotificationOrThrow(notificationId, null);
  const responseBody = {
    success: true,
    data: {
      notification: notificationToResponse(updated),
      simulated: true,
      realSmsSent: false,
      message: "The failed notification was queued for another simulated attempt.",
    },
  };
  const responseStatus = 202;
  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "NOTIFICATION_MANUALLY_RETRIED",
        entityAffected: "NOTIFICATION",
        recordId: notificationId,
        ipAddress: clientIpAddress(req),
        details: {
          notificationType: updated.notificationType,
          simulated: true,
          realSmsSent: false,
        },
      },
    });
    await saveIdempotencyRecord({ identity, requestHash, responseStatus, responseBody }, tx);
  });
  await publishNotificationLifecycle("notification.queued", updated, {
    status: "PENDING",
    reason: "MANUAL_RETRY",
    simulated: true,
    realSmsSent: false,
  });
  return sendIdempotentResponse(res, { responseStatus, responseBody }, false);
});

export const getNotificationQueueHealth = asyncHandler(async (req, res) => {
  assertNotificationReadAllowed(req.staffUser);
  const health = await notificationQueueHealth();
  res.status(health.status === "ready" ? 200 : 503).json({
    success: health.status === "ready",
    data: health,
  });
});
