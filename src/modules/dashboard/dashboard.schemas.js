import { z } from "zod";
import { DISTRIBUTION_STATUSES, isValidDateOnly } from "../distributions/distribution.schemas.js";

export const CLAIM_REPORT_STATUSES = Object.freeze([
  "PENDING",
  "VERIFIED",
  "CLAIMED",
  "REJECTED",
  "VOIDED",
]);

export const SCHEDULE_REPORT_STATUSES = Object.freeze([
  "SCHEDULED",
  "CHECKED_IN",
  "MISSED",
  "CANCELLED",
]);

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

const optionalDateOnly = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim()
    .refine(isValidDateOnly, "Date must use a valid YYYY-MM-DD value.")
    .transform((value) => new Date(`${value}T00:00:00.000Z`))
    .optional(),
);

function timestampBoundary(endOfDay) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().refine((value) => {
      if (isValidDateOnly(value)) return true;
      return z.iso.datetime({ offset: true }).safeParse(value).success;
    }, "Use YYYY-MM-DD or an ISO 8601 timestamp with an offset.")
      .transform((value) => {
        if (!isValidDateOnly(value)) return new Date(value);
        return new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+08:00`);
      })
      .optional(),
  );
}

const optionalUppercaseEnum = (values) => z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(values).optional(),
);

function orderedRange(schema) {
  return schema.superRefine((value, context) => {
    if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
      context.addIssue({
        code: "custom",
        path: ["dateTo"],
        message: "dateTo must be the same as or later than dateFrom.",
      });
    }
  });
}

export const dashboardOverviewQuerySchema = orderedRange(z.object({
  programId: z.uuid().optional(),
  barangayId: z.uuid().optional(),
  status: optionalUppercaseEnum(DISTRIBUTION_STATUSES),
  dateFrom: optionalDateOnly,
  dateTo: optionalDateOnly,
}).strict());

export const dashboardDistributionParamsSchema = z.object({
  distributionId: z.uuid(),
}).strict();

export const anomalyQuerySchema = orderedRange(z.object({
  ...pagination,
  dateFrom: timestampBoundary(false),
  dateTo: timestampBoundary(true),
}).strict());

export const claimReportQuerySchema = orderedRange(z.object({
  ...pagination,
  status: optionalUppercaseEnum(CLAIM_REPORT_STATUSES),
  dateFrom: timestampBoundary(false),
  dateTo: timestampBoundary(true),
}).strict());

export const scheduleReportQuerySchema = orderedRange(z.object({
  ...pagination,
  status: optionalUppercaseEnum(SCHEDULE_REPORT_STATUSES),
  dateFrom: timestampBoundary(false),
  dateTo: timestampBoundary(true),
}).strict());

export const fundUtilizationQuerySchema = orderedRange(z.object({
  ...pagination,
  programId: z.uuid().optional(),
  barangayId: z.uuid().optional(),
  distributionId: z.uuid().optional(),
  status: optionalUppercaseEnum(DISTRIBUTION_STATUSES),
  dateFrom: optionalDateOnly,
  dateTo: optionalDateOnly,
}).strict());

export const emptyReportQuerySchema = z.object({}).strict();
