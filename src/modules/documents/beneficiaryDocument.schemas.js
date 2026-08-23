import { z } from "zod";
import { BENEFICIARY_DOCUMENT_TYPES } from "./beneficiaryDocument.constants.js";

export const beneficiaryDocumentMetadataSchema = z.object({
  documentType: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(BENEFICIARY_DOCUMENT_TYPES),
  ),
}).strict();

export const beneficiaryDocumentListParamsSchema = z.object({
  beneficiaryId: z.uuid(),
}).strict();

export const beneficiaryDocumentParamsSchema = z.object({
  beneficiaryId: z.uuid(),
  documentId: z.uuid(),
}).strict();

export const beneficiaryDocumentReviewSchema = z.object({
  decision: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(["ACCEPTED", "REJECTED"]),
  ),
  reason: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(5).max(2000).optional(),
  ),
}).strict().superRefine((value, context) => {
  if (value.decision === "REJECTED" && !value.reason) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "A meaningful rejection reason of at least 5 characters is required.",
    });
  }
});
