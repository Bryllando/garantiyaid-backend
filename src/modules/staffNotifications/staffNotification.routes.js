import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { validateParams, validateQuery } from "../../middleware/validate.js";
import {
  listStaffNotifications,
  markAllStaffNotificationsRead,
  markStaffNotificationRead,
} from "./staffNotification.controller.js";
import {
  staffNotificationIdSchema,
  staffNotificationListQuerySchema,
} from "./staffNotification.schemas.js";

const staffNotificationRoutes = Router();

staffNotificationRoutes.use(authenticateStaff);
staffNotificationRoutes.get("/", validateQuery(staffNotificationListQuerySchema), listStaffNotifications);
staffNotificationRoutes.post("/read-all", markAllStaffNotificationsRead);
staffNotificationRoutes.patch(
  "/:notificationId/read",
  validateParams(staffNotificationIdSchema),
  markStaffNotificationRead,
);

export default staffNotificationRoutes;
