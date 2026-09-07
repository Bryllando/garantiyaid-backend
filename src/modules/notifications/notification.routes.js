import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { notificationRateLimiter } from "../../middleware/rateLimit.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
import {
  enqueueDistributionNotifications,
  enqueueAssistantDistributionReminder,
  enqueueScheduleNotification,
  getNotification,
  getNotificationQueueHealth,
  listDistributionNotifications,
  listNotifications,
  previewAssistantDistributionReminder,
  retryNotification,
  summarizeNotifications,
} from "./notification.controller.js";
import {
  NOTIFICATION_ENQUEUE_ROLES,
  NOTIFICATION_READ_ROLES,
  NOTIFICATION_RETRY_ROLES,
} from "./notification.policy.js";
import {
  distributionNotificationEnqueueSchema,
  assistantReminderEnqueueSchema,
  assistantReminderPreviewSchema,
  distributionNotificationListQuerySchema,
  emptyNotificationBodySchema,
  notificationIdSchema,
  notificationListQuerySchema,
  notificationSummaryQuerySchema,
  scheduleNotificationEnqueueSchema,
  scheduleNotificationParamsSchema,
} from "./notification.schemas.js";
import { distributionIdSchema } from "../distributions/distribution.schemas.js";

const notificationRoutes = Router();
notificationRoutes.use(authenticateStaff);
notificationRoutes.get(
  "/queue/health",
  authorizeRoles(...NOTIFICATION_READ_ROLES),
  getNotificationQueueHealth,
);
notificationRoutes.get(
  "/summary",
  authorizeRoles(...NOTIFICATION_READ_ROLES),
  validateQuery(notificationSummaryQuerySchema),
  summarizeNotifications,
);
notificationRoutes.get(
  "/",
  authorizeRoles(...NOTIFICATION_READ_ROLES),
  validateQuery(notificationListQuerySchema),
  listNotifications,
);
notificationRoutes.get(
  "/:notificationId",
  authorizeRoles(...NOTIFICATION_READ_ROLES),
  validateParams(notificationIdSchema),
  getNotification,
);
notificationRoutes.post(
  "/:notificationId/retry",
  authorizeRoles(...NOTIFICATION_RETRY_ROLES),
  notificationRateLimiter,
  validateParams(notificationIdSchema),
  validateBody(emptyNotificationBodySchema),
  retryNotification,
);

export const distributionNotificationRoutes = Router();
distributionNotificationRoutes.use(authenticateStaff);
distributionNotificationRoutes.post(
  "/:distributionId/notifications/assistant-preview",
  authorizeRoles(...NOTIFICATION_ENQUEUE_ROLES),
  notificationRateLimiter,
  validateParams(distributionIdSchema),
  validateBody(assistantReminderPreviewSchema),
  previewAssistantDistributionReminder,
);
distributionNotificationRoutes.post(
  "/:distributionId/notifications/assistant-enqueue",
  authorizeRoles(...NOTIFICATION_ENQUEUE_ROLES),
  notificationRateLimiter,
  validateParams(distributionIdSchema),
  validateBody(assistantReminderEnqueueSchema),
  enqueueAssistantDistributionReminder,
);
distributionNotificationRoutes.get(
  "/:distributionId/notifications",
  authorizeRoles(...NOTIFICATION_READ_ROLES),
  validateParams(distributionIdSchema),
  validateQuery(distributionNotificationListQuerySchema),
  listDistributionNotifications,
);
distributionNotificationRoutes.post(
  "/:distributionId/notifications/enqueue",
  authorizeRoles(...NOTIFICATION_ENQUEUE_ROLES),
  notificationRateLimiter,
  validateParams(distributionIdSchema),
  validateBody(distributionNotificationEnqueueSchema),
  enqueueDistributionNotifications,
);

export const scheduleNotificationRoutes = Router();
scheduleNotificationRoutes.use(authenticateStaff);
scheduleNotificationRoutes.post(
  "/:scheduleId/notifications/enqueue",
  authorizeRoles(...NOTIFICATION_ENQUEUE_ROLES),
  notificationRateLimiter,
  validateParams(scheduleNotificationParamsSchema),
  validateBody(scheduleNotificationEnqueueSchema),
  enqueueScheduleNotification,
);

export default notificationRoutes;
