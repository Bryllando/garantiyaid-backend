import { z } from "zod";

export const SIMULATED_TRANSACTION_TYPES = Object.freeze([
  "BENEFIT_CREDIT",
  "SIMULATED_TRANSFER_OUT",
  "SIMULATED_TRANSFER_IN",
  "BENEFIT_REVERSAL",
]);

export const TRANSACTION_STATUSES = Object.freeze([
  "PENDING",
  "COMPLETED",
  "FAILED",
  "REVERSED",
]);

const optionalDescription = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(255).optional(),
);

const moneyAmount = z.coerce.number()
  .finite()
  .positive()
  .max(9_999_999_999.99)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, {
    message: "amount must have no more than two decimal places.",
  });

export const createWalletSchema = z.object({
  beneficiaryId: z.uuid(),
}).strict();

export const walletParamsSchema = z.object({
  walletId: z.uuid(),
}).strict();

export const walletTransactionParamsSchema = z.object({
  walletId: z.uuid(),
  transactionId: z.uuid(),
}).strict();

export const creditClaimParamsSchema = z.object({
  distributionId: z.uuid(),
  claimId: z.uuid(),
}).strict();

export const creditClaimSchema = z.object({
  description: optionalDescription,
}).strict();

export const simulatedTransferSchema = z.object({
  recipientBeneficiaryId: z.uuid(),
  amount: moneyAmount,
  description: optionalDescription,
}).strict();

export const reverseBenefitCreditSchema = z.object({
  reason: z.string().trim().min(5).max(255),
}).strict();

export const walletTransactionListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  type: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(SIMULATED_TRANSACTION_TYPES).optional(),
  ),
  status: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(TRANSACTION_STATUSES).optional(),
  ),
}).strict();

export const distributionTransactionListQuerySchema = walletTransactionListQuerySchema.extend({
  beneficiaryId: z.uuid().optional(),
  claimId: z.uuid().optional(),
}).strict();

export const creditableClaimListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
