import { z } from "zod";
import { isValidDateOnly, isValidTimeOnly } from "./distribution.schemas.js";

export const DISTRIBUTION_SLOT_STATUSES = Object.freeze([
  "AVAILABLE",
  "FULL",
  "CLOSED",
]);

const slotCapacity = z.coerce.number().int().min(1).max(1000);

const sessionDate = z.string().trim()
  .refine(isValidDateOnly, "Session date must use a valid YYYY-MM-DD value.")
  .transform((value) => new Date(`${value}T00:00:00.000Z`));

const sessionTime = z.string().trim()
  .refine(isValidTimeOnly, "Session time must use a valid 24-hour HH:mm value.")
  .transform((value) => new Date(`1970-01-01T${value}:00.000Z`));

const distributionSession = z.object({
  label: z.string().trim().min(1).max(120),
  date: sessionDate,
  startTime: sessionTime,
  endTime: sessionTime,
  location: z.string().trim().min(1).max(200),
  capacity: slotCapacity,
  serviceAreas: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
}).strict().superRefine((session, context) => {
  const normalizedAreas = session.serviceAreas.map((area) => area.toLocaleLowerCase("en-PH"));
  if (new Set(normalizedAreas).size !== normalizedAreas.length) {
    context.addIssue({
      code: "custom",
      path: ["serviceAreas"],
      message: "A service area may appear only once in a session.",
    });
  }
});

export const generateDistributionSlotsSchema = z.object({
  capacity: slotCapacity.optional(),
  sessions: z.array(distributionSession).min(1).max(30).optional(),
}).strict().superRefine((value, context) => {
  if ((value.capacity == null) === (value.sessions == null)) {
    context.addIssue({
      code: "custom",
      message: "Provide either a capacity for the main session or a sessions list.",
    });
  }
});

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
