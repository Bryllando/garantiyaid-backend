ALTER TABLE "users" ADD COLUMN "archived_at" TIMESTAMPTZ(6);

CREATE INDEX "users_archived_at_idx" ON "users"("archived_at");
