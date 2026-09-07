import prisma from "../../lib/prisma.js";
import { publishRealtimeEvent } from "../../realtime/socket.js";

export const staffNotificationSelect = {
  notificationId: true,
  notificationType: true,
  title: true,
  message: true,
  targetPath: true,
  readAt: true,
  createdAt: true,
};

export function staffNotificationToResponse(notification) {
  return {
    ...notification,
    readAt: notification.readAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
  };
}

function safeTargetPath(targetPath) {
  if (targetPath == null) return null;
  if (!targetPath.startsWith("/") || targetPath.startsWith("//")) {
    throw new TypeError("Staff notification targetPath must be an internal application path.");
  }
  return targetPath;
}

export async function createStaffNotification(notification, database = prisma) {
  const data = {
    userId: notification.userId,
    notificationType: notification.notificationType,
    title: notification.title,
    message: notification.message,
    targetPath: safeTargetPath(notification.targetPath),
    deduplicationKey: notification.deduplicationKey ?? null,
  };
  if (!data.deduplicationKey) {
    return database.staffNotification.create({ data, select: staffNotificationSelect });
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
    select: staffNotificationSelect,
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
