import { z } from "zod";

const optionalUppercaseText = (maximumLength) => z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(maximumLength).transform((value) => value.toUpperCase()).optional(),
);

const optionalDateTime = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
);

export const auditLogIdSchema = z.object({
  auditId: z.uuid(),
}).strict();

export const auditLogListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  action: optionalUppercaseText(100),
  entityAffected: optionalUppercaseText(50),
  recordId: z.uuid().optional(),
  userId: z.uuid().optional(),
  dateFrom: optionalDateTime,
  dateTo: optionalDateTime,
}).strict().superRefine((value, context) => {
  if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
    context.addIssue({
      code: "custom",
      path: ["dateTo"],
      message: "dateTo must be the same as or later than dateFrom.",
    });
  }
});
