-- Phase 6 is a closed-loop simulation. These fields support an auditable
-- ledger without connecting to banks, e-wallets, or real payment rails.
ALTER TABLE "transactions"
ALTER COLUMN "claim_id" DROP NOT NULL,
ALTER COLUMN "transaction_type" TYPE VARCHAR(30),
ADD COLUMN "distribution_id" UUID,
ADD COLUMN "initiated_by" UUID,
ADD COLUMN "balance_before" DECIMAL(12,2),
ADD COLUMN "balance_after" DECIMAL(12,2),
ADD COLUMN "transfer_group_id" UUID,
ADD COLUMN "reversal_of_id" UUID,
ADD COLUMN "description" VARCHAR(255),
ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing Phase 1-5 environments do not create transaction rows. The
-- backfill keeps the migration safe if a development database contains
-- manually inserted legacy rows.
UPDATE "transactions" AS transaction
SET
  "distribution_id" = claim."distribution_id",
  "balance_before" = 0,
  "balance_after" = transaction."amount"
FROM "claims" AS claim
WHERE transaction."claim_id" = claim."claim_id"
  AND transaction."balance_before" IS NULL;

UPDATE "transactions"
SET
  "balance_before" = 0,
  "balance_after" = GREATEST("amount", 0)
WHERE "balance_before" IS NULL;

ALTER TABLE "transactions"
ALTER COLUMN "balance_before" SET NOT NULL,
ALTER COLUMN "balance_after" SET NOT NULL,
ADD CONSTRAINT "transactions_amount_positive_check" CHECK ("amount" > 0),
ADD CONSTRAINT "transactions_balance_before_nonnegative_check" CHECK ("balance_before" >= 0),
ADD CONSTRAINT "transactions_balance_after_nonnegative_check" CHECK ("balance_after" >= 0),
ADD CONSTRAINT "transactions_distribution_id_fkey"
  FOREIGN KEY ("distribution_id") REFERENCES "distributions"("distribution_id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "transactions_initiated_by_fkey"
  FOREIGN KEY ("initiated_by") REFERENCES "users"("user_id")
  ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "transactions_reversal_of_id_fkey"
  FOREIGN KEY ("reversal_of_id") REFERENCES "transactions"("transaction_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "transactions_reversal_of_id_key"
ON "transactions"("reversal_of_id");

-- Exactly one benefit credit may ever be recorded for a claim, including a
-- credit that was subsequently reversed.
CREATE UNIQUE INDEX "transactions_one_benefit_credit_per_claim_key"
ON "transactions"("claim_id")
WHERE "transaction_type" = 'BENEFIT_CREDIT';

CREATE INDEX "transactions_distribution_id_status_created_at_idx"
ON "transactions"("distribution_id", "status", "created_at");

CREATE INDEX "transactions_wallet_id_created_at_idx"
ON "transactions"("wallet_id", "created_at");

CREATE INDEX "transactions_claim_id_transaction_type_idx"
ON "transactions"("claim_id", "transaction_type");

CREATE INDEX "transactions_transfer_group_id_idx"
ON "transactions"("transfer_group_id");

ALTER TABLE "wallet_accounts"
ADD CONSTRAINT "wallet_accounts_balance_nonnegative_check" CHECK ("balance" >= 0),
ADD CONSTRAINT "wallet_accounts_currency_php_check" CHECK ("currency" = 'PHP'),
ADD CONSTRAINT "wallet_accounts_status_check"
  CHECK ("account_status" IN ('ACTIVE', 'SUSPENDED', 'CLOSED'));
