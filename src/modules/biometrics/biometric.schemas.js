import { z } from "zod";

export const BIOMETRIC_ATTEMPT_RESULTS = Object.freeze([
  "MATCHED",
  "NO_MATCH",
  "LIVENESS_FAILED",
  "CONSENT_INVALID",
  "PROFILE_UNAVAILABLE",
  "DUPLICATE",
  "PROCESSOR_ERROR",
]);

const optionalDeviceInfo = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(255).optional(),
);

export const biometricConsentParamsSchema = z.object({
  beneficiaryId: z.uuid(),
  consentId: z.uuid(),
}).strict();

export const biometricEnrollmentSchema = z.object({
  consentId: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.uuid().optional(),
  ),
}).strict();

export const verifyBiometricClaimSchema = z.object({
  beneficiaryId: z.uuid(),
  deviceInfo: optionalDeviceInfo,
}).strict();

export const claimSignatureParamsSchema = z.object({
  distributionId: z.uuid(),
  claimId: z.uuid(),
}).strict();

export const submitClaimSignatureSchema = z.object({
  signatureDataUrl: z.string().max(350_000),
  signatureMethod: z.enum(["DRAWN", "TYPED"]).default("DRAWN"),
  pointCount: z.coerce.number().int().min(8).max(5_000).optional(),
  typedName: z.string().trim().min(2).max(200).optional(),
  attestation: z.literal(true),
  deviceInfo: optionalDeviceInfo,
}).strict().superRefine((value, context) => {
  if (value.signatureMethod === "DRAWN" && value.pointCount === undefined) {
    context.addIssue({ code: "custom", path: ["pointCount"], message: "A drawn signature requires at least 8 recorded points." });
  }
  if (value.signatureMethod === "TYPED" && !value.typedName) {
    context.addIssue({ code: "custom", path: ["typedName"], message: "Enter the beneficiary's full legal name for a typed signature." });
  }
  if (value.signatureMethod === "TYPED" && value.pointCount !== undefined) {
    context.addIssue({ code: "custom", path: ["pointCount"], message: "A typed signature must not include drawn points." });
  }
});

export const biometricConsentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export const biometricAttemptListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  result: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(BIOMETRIC_ATTEMPT_RESULTS).optional(),
  ),
  beneficiaryId: z.uuid().optional(),
  claimId: z.uuid().optional(),
}).strict();

export const biometricDuplicateCaseListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value.trim().toUpperCase() : undefined),
    z.enum(["PENDING", "CLEARED", "CONFIRMED"]).optional(),
  ),
  barangayId: z.uuid().optional(),
}).strict();

export const biometricDuplicateCaseParamsSchema = z.object({
  duplicateCaseId: z.uuid(),
}).strict();

export const reviewBiometricDuplicateCaseSchema = z.object({
  action: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(["CLEAR_AS_DISTINCT", "CONFIRM_DUPLICATE"]),
  ),
  reviewNotes: z.string().trim().min(20).max(1000),
  attestation: z.literal(true),
}).strict();
