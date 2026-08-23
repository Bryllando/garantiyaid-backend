import { z } from "zod";

export const DISTRIBUTION_SCHEDULE_STATUSES = Object.freeze([
  "SCHEDULED",
  "CHECKED_IN",
  "MISSED",
  "CANCELLED",
]);

const optionalSearch = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(100).optional(),
);

export const createDistributionScheduleSchema = z.object({
  allocationId: z.uuid(),
  slotId: z.uuid(),
}).strict();

export const generateDistributionSchedulesSchema = z.object({
  allocationIds: z.array(z.uuid()).min(1).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.allocationIds && new Set(value.allocationIds).size !== value.allocationIds.length) {
    context.addIssue({
      code: "custom",
      path: ["allocationIds"],
      message: "allocationIds must not contain duplicates.",
    });
  }
});

export const rescheduleDistributionScheduleSchema = z.object({
  slotId: z.uuid(),
}).strict();

export const distributionScheduleParamsSchema = z.object({
  distributionId: z.uuid(),
  scheduleId: z.uuid(),
}).strict();

export const distributionScheduleListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(DISTRIBUTION_SCHEDULE_STATUSES).optional(),
  ),
  slotId: z.uuid().optional(),
  search: optionalSearch,
}).strict();

export const schedulableAllocationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: optionalSearch,
}).strict();

