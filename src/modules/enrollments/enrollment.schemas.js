import { z } from "zod";

const enrollmentStatuses = [
  "PENDING",
  "FOR_VALIDATION",
  "NEEDS_CORRECTION",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
  "WITHDRAWN",
];

export const submitEnrollmentSchema = z.object({
  beneficiaryId: z.uuid(),
}).strict();

export const programEnrollmentParamsSchema = z.object({
  programId: z.uuid(),
}).strict();

export const enrollmentIdSchema = z.object({
  enrollmentId: z.uuid(),
}).strict();

export const enrollmentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(enrollmentStatuses).optional(),
  programId: z.uuid().optional(),
  barangayId: z.uuid().optional(),
  search: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(100).optional(),
  ),
}).strict();

export const enrollmentDecisionSchema = z.object({
  reason: z.string().trim().min(5).max(2000),
}).strict();

export const enrollmentApprovalSchema = z.object({
  remarks: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(2000).optional(),
  ),
}).strict();
