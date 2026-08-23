import { z } from "zod";

export const QR_TOKEN_STATUSES = Object.freeze([
  "ACTIVE",
  "USED",
  "EXPIRED",
  "REVOKED",
]);

export const CLAIM_STATUSES = Object.freeze([
  "PENDING",
  "VERIFIED",
  "CLAIMED",
  "REJECTED",
  "VOIDED",
]);

export const QR_SCAN_RESULTS = Object.freeze([
  "VERIFIED",
  "INVALID_TOKEN",
  "EXPIRED",
  "REVOKED",
  "DUPLICATE",
  "INVALID_SCHEDULE",
  "INVALID_ALLOCATION",
  "PENDING_BIOMETRIC",
]);

const optionalSearch = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(100).optional(),
);

export const generateQrTokensSchema = z.object({
  scheduleIds: z.array(z.uuid()).min(1).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.scheduleIds && new Set(value.scheduleIds).size !== value.scheduleIds.length) {
    context.addIssue({
      code: "custom",
      path: ["scheduleIds"],
      message: "scheduleIds must not contain duplicates.",
    });
  }
});

export const verifyQrClaimSchema = z.object({
  token: z.string().trim().min(1).max(512),
  deviceInfo: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(1).max(255).optional(),
  ),
}).strict();

export const qrTokenParamsSchema = z.object({
  distributionId: z.uuid(),
  qrTokenId: z.uuid(),
}).strict();

export const claimParamsSchema = z.object({
  distributionId: z.uuid(),
  claimId: z.uuid(),
}).strict();

export const qrEligibleScheduleListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: optionalSearch,
}).strict();

export const qrTokenListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(QR_TOKEN_STATUSES).optional(),
  ),
  search: optionalSearch,
}).strict();

export const claimListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(CLAIM_STATUSES).optional(),
  ),
  search: optionalSearch,
}).strict();

export const qrScanLogListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  result: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(QR_SCAN_RESULTS).optional(),
  ),
  qrTokenId: z.uuid().optional(),
  claimId: z.uuid().optional(),
}).strict();
