ALTER TABLE "notifications"
ADD COLUMN "recipient_masked" VARCHAR(30),
ADD COLUMN "delivery_context_hash" VARCHAR(64);
