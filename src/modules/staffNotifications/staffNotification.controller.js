import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import {
  staffNotificationSelect,
  staffNotificationToResponse,
} from "./staffNotification.service.js";

const ownNotifications = (userId) => ({ userId });

export const listStaffNotifications = asyncHandler(async (req, res) => {
  const where = ownNotifications(req.auth.userId);
  const [notifications, unreadCount] = await Promise.all([
    prisma.staffNotification.findMany({
      where,
      select: staffNotificationSelect,
      orderBy: [{ createdAt: "desc" }, { notificationId: "desc" }],
      take: req.validatedQuery.pageSize,
    }),
    prisma.staffNotification.count({ where: { ...where, readAt: null } }),
  ]);
  res.set("Cache-Control", "no-store");
  res.status(200).json({
    success: true,
    data: {
      notifications: notifications.map(staffNotificationToResponse),
      unreadCount,
    },
  });
});

export const markStaffNotificationRead = asyncHandler(async (req, res) => {
  const where = {
    notificationId: req.validatedParams.notificationId,
    userId: req.auth.userId,
  };
  const existing = await prisma.staffNotification.findFirst({ where, select: staffNotificationSelect });
  if (!existing) throw new AppError(404, "STAFF_NOTIFICATION_NOT_FOUND", "Notification was not found.");
  const notification = existing.readAt ? existing : await prisma.staffNotification.update({
    where: { notificationId: existing.notificationId },
    data: { readAt: new Date() },
    select: staffNotificationSelect,
  });
  const unreadCount = await prisma.staffNotification.count({
    where: { userId: req.auth.userId, readAt: null },
  });
  res.status(200).json({
    success: true,
    data: { notification: staffNotificationToResponse(notification), unreadCount },
  });
});

export const markAllStaffNotificationsRead = asyncHandler(async (req, res) => {
  const result = await prisma.staffNotification.updateMany({
    where: { userId: req.auth.userId, readAt: null },
    data: { readAt: new Date() },
  });
  res.status(200).json({
    success: true,
    data: { updatedCount: result.count, unreadCount: 0 },
  });
});
