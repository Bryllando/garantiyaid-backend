import prisma from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { enqueueNotificationJobs, notificationQueueHealth } from "../../queues/notification.queue.js";
import { publishNotificationLifecycle } from "../../realtime/publishers.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
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

async function enqueueRows(req, operation, schedules) {
  assertNotificationTypeAllowed(req.staffUser, req.validatedBody.notificationType);
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
    notificationType: req.validatedBody.notificationType,
    sendAt: req.validatedBody.sendAt,
    initiatedById: req.auth.userId,
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
          notificationType: req.validatedBody.notificationType,
          requestedCount: schedules.length,
          queuedCount: pending.length,
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
