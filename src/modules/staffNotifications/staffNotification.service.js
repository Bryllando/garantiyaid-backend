import prisma from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { publishRealtimeEvent } from "../../realtime/socket.js";

export const staffNotificationSelect = {
  notificationId: true,
  notificationType: true,
  title: true,
  message: true,
  targetPath: true,
  readAt: true,
  createdAt: true,
  emailProviderMode: true,
  emailRecipient: true,
  emailStatus: true,
  emailSentAt: true,
  emailFailedAt: true,
};

export const staffNotificationDeliverySelect = {
  ...staffNotificationSelect,
  userId: true,
  emailProviderReference: true,
  emailAttemptCount: true,
  emailLastErrorCode: true,
  emailProcessingToken: true,
  emailProcessingStartedAt: true,
};

export function maskEmailAddress(email) {
  if (typeof email !== "string" || !email.includes("@")) return null;
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}${"*".repeat(Math.min(5, Math.max(2, local.length - 1)))}@${domain}`;
}

export function emailDeliveryToResponse(notification) {
  const configured = notification?.emailProviderMode === "GMAIL_API";
  return {
    configured,
    provider: notification?.emailProviderMode ?? env.emailProviderMode,
    status: configured ? (notification?.emailStatus ?? "PENDING") : "DISABLED",
    recipientMasked: maskEmailAddress(notification?.emailRecipient),
    sentAt: notification?.emailSentAt?.toISOString() ?? null,
    failedAt: notification?.emailFailedAt?.toISOString() ?? null,
  };
}

export function staffNotificationToResponse(notification) {
  const {
    userId,
    emailProviderMode,
    emailRecipient,
    emailStatus,
    emailProviderReference,
    emailAttemptCount,
    emailLastErrorCode,
    emailProcessingToken,
    emailProcessingStartedAt,
    emailSentAt,
    emailFailedAt,
    ...publicFields
  } = notification;
  return {
    ...publicFields,
    readAt: notification.readAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
    ...(emailRecipient ? { emailDelivery: emailDeliveryToResponse(notification) } : {}),
  };
}

export async function listStaffEmailDeliveries(userId, database = prisma) {
  const notifications = await database.staffNotification.findMany({
    where: { userId, notificationType: { startsWith: "SECURITY_" }, emailRecipient: { not: null } },
    select: staffNotificationSelect,
    orderBy: [{ createdAt: "desc" }, { notificationId: "desc" }],
    take: 20,
  });
  return notifications.map(staffNotificationToResponse);
}

function safeTargetPath(targetPath) {
  if (targetPath == null) return null;
  if (!targetPath.startsWith("/") || targetPath.startsWith("//")) {
    throw new TypeError("Staff notification targetPath must be an internal application path.");
  }
  return targetPath;
}

export async function createStaffNotification(notification, database = prisma) {
  const emailRecipient = notification.emailRecipient?.trim().toLowerCase() ?? null;
  const data = {
    userId: notification.userId,
    notificationType: notification.notificationType,
    title: notification.title,
    message: notification.message,
    targetPath: safeTargetPath(notification.targetPath),
    deduplicationKey: notification.deduplicationKey ?? null,
    ...(emailRecipient ? {
      emailProviderMode: env.emailProviderMode,
      emailRecipient,
      emailStatus: env.emailProviderMode === "GMAIL_API" ? "PENDING" : "NOT_REQUESTED",
    } : {}),
  };
  if (!data.deduplicationKey) {
    return database.staffNotification.create({ data, select: staffNotificationDeliverySelect });
  }
  return database.staffNotification.upsert({
    where: {
      userId_deduplicationKey: {
        userId: data.userId,
        deduplicationKey: data.deduplicationKey,
      },
    },
    create: data,
    update: {},
    select: staffNotificationDeliverySelect,
  });
}

export function publishStaffNotificationCreated(notification, publish = publishRealtimeEvent) {
  return publish("staff.notification.created", {
    userId: notification.userId,
    data: {
      notificationId: notification.notificationId,
      createdAt: notification.createdAt,
    },
  });
}

export async function notifyStaffScope({
  barangayId,
  notificationType,
  title,
  message,
  targetPaths,
  deduplicationKey,
}, { database = prisma, publish = publishRealtimeEvent } = {}) {
  const users = await database.user.findMany({
    where: {
      isActive: true,
      OR: [
        { role: { in: ["SYSTEM_ADMIN", "DSWD_STAFF"] } },
        ...(barangayId ? [{ role: "BARANGAY_FACILITATOR", barangayId }] : []),
      ],
    },
    select: { userId: true, role: true },
  });
  const created = await Promise.all(users.map(async (user) => ({
    userId: user.userId,
    notification: await createStaffNotification({
      userId: user.userId,
      notificationType,
      title,
      message,
      targetPath: targetPaths[user.role],
      deduplicationKey,
    }, database),
  })));
  await Promise.all(created.map(({ userId, notification }) => publishStaffNotificationCreated(
    { ...notification, userId },
    publish,
  )));
  return created.map(({ notification }) => notification);
}
