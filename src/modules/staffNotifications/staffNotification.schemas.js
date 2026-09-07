import { z } from "zod";

export const staffNotificationListQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(20).default(8),
}).strict();

export const staffNotificationIdSchema = z.object({
  notificationId: z.uuid(),
}).strict();
