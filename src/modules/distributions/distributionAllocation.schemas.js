import { z } from "zod";

export const DISTRIBUTION_ALLOCATION_STATUSES = Object.freeze([
  "PENDING",
  "ALLOCATED",
  "CANCELLED",
  "CLAIMED",
]);

const paginationFields = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

const optionalSearch = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(100).optional(),
);

export const eligibleEnrollmentListQuerySchema = z.object({
  ...paginationFields,
  search: optionalSearch,
}).strict();

export const createDistributionAllocationsSchema = z.object({
  enrollmentIds: z.array(z.uuid()).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.enrollmentIds).size !== value.enrollmentIds.length) {
    context.addIssue({
      code: "custom",
      path: ["enrollmentIds"],
      message: "enrollmentIds must not contain duplicate values.",
    });
  }
});

export const distributionAllocationListQuerySchema = z.object({
  ...paginationFields,
  search: optionalSearch,
  status: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(DISTRIBUTION_ALLOCATION_STATUSES).optional(),
  ),
}).strict();

export const distributionAllocationParamsSchema = z.object({
  distributionId: z.uuid(),
  allocationId: z.uuid(),
}).strict();

export const idempotencyKeySchema = z.uuid();
