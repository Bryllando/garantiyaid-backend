import { z } from "zod";

export const DISTRIBUTION_SLOT_STATUSES = Object.freeze([
  "AVAILABLE",
  "FULL",
  "CLOSED",
]);

const slotCapacity = z.coerce.number().int().min(1).max(1000);

export const generateDistributionSlotsSchema = z.object({
  capacity: slotCapacity,
}).strict();

export const updateDistributionSlotSchema = z.object({
  capacity: slotCapacity,
}).strict();

export const distributionSlotParamsSchema = z.object({
  distributionId: z.uuid(),
  slotId: z.uuid(),
}).strict();

export const distributionSlotListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  slotStatus: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(DISTRIBUTION_SLOT_STATUSES).optional(),
  ),
}).strict();
