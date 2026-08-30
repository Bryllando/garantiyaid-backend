import { z } from "zod";

export const DISTRIBUTION_STATUSES = Object.freeze([
  "DRAFT",
  "OPEN",
  "CLOSED",
  "CANCELLED",
]);

export const VERIFICATION_REQUIREMENTS = Object.freeze([
  "QR",
  "BIOMETRIC",
  "QR_AND_BIOMETRIC",
  "BIOMETRIC_AND_SIGNATURE",
]);

export function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isValidTimeOnly(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

const dateOnly = z.string().trim()
  .refine(isValidDateOnly, "Date must use a valid YYYY-MM-DD value.")
  .transform((value) => new Date(`${value}T00:00:00.000Z`));

const timeOnly = z.string().trim()
  .refine(isValidTimeOnly, "Time must use a valid 24-hour HH:mm value.")
  .transform((value) => new Date(`1970-01-01T${value}:00.000Z`));

const optionalDateOnly = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  dateOnly.optional(),
);

const distributionFields = {
  programId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  distributionDate: dateOnly,
  startTime: timeOnly,
  endTime: timeOnly,
  slotDurationMinutes: z.coerce.number().int().min(5).max(720),
  location: z.string().trim().min(1).max(200),
  barangayId: z.uuid(),
  verificationRequirement: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(VERIFICATION_REQUIREMENTS).default("QR"),
  ),
};

export const createDistributionSchema = z.object(distributionFields).strict();

export const updateDistributionSchema = z.object(distributionFields).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one distribution event field must be supplied.",
);

export const distributionIdSchema = z.object({
  distributionId: z.uuid(),
}).strict();

export const distributionListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  programId: z.uuid().optional(),
  barangayId: z.uuid().optional(),
  status: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(DISTRIBUTION_STATUSES).optional(),
  ),
  dateFrom: optionalDateOnly,
  dateTo: optionalDateOnly,
}).strict().superRefine((value, context) => {
  if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
    context.addIssue({
      code: "custom",
      path: ["dateTo"],
      message: "dateTo must be the same as or later than dateFrom.",
    });
  }
});
