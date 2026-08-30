import { z } from "zod";

export const CLAIM_DISPUTE_STATUSES = Object.freeze([
  "OPEN",
  "UNDER_REVIEW",
  "REFERRED",
  "RESOLVED",
]);

export const CLAIM_DISPUTE_REASONS = Object.freeze([
  "BENEFICIARY_DENIES_RECEIPT",
  "AMOUNT_OR_ASSISTANCE_MISMATCH",
  "SUSPECTED_IDENTITY_MISUSE",
  "RECEIPT_OR_RECORD_ERROR",
  "OTHER",
]);

export const CLAIM_DISPUTE_REVIEW_ACTIONS = Object.freeze([
  "START_REVIEW",
  "REFER_FOR_INVESTIGATION",
  "CONFIRM_CLAIM",
  "COMPLETE_REMEDIATION",
]);

const normalizedEnum = (values) => z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(values),
);

export const claimDisputeParamsSchema = z.object({
  distributionId: z.uuid(),
  disputeId: z.uuid(),
}).strict();

export const createClaimDisputeSchema = z.object({
  reasonCode: normalizedEnum(CLAIM_DISPUTE_REASONS),
  statement: z.string().trim().min(20).max(2000),
  beneficiaryPresent: z.literal(true),
}).strict();

export const claimDisputeListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    normalizedEnum(CLAIM_DISPUTE_STATUSES).optional(),
  ),
  search: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(1).max(100).optional(),
  ),
}).strict();

export const reviewClaimDisputeSchema = z.object({
  action: normalizedEnum(CLAIM_DISPUTE_REVIEW_ACTIONS),
  reviewNotes: z.string().trim().min(20).max(2000).optional(),
}).strict().superRefine((value, context) => {
  if (value.action !== "START_REVIEW" && !value.reviewNotes) {
    context.addIssue({
      code: "custom",
      path: ["reviewNotes"],
      message: "Review notes are required for this decision.",
    });
  }
});
