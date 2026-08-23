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
