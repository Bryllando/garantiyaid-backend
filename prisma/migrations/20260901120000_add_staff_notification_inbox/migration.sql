CREATE TABLE "staff_notifications" (
  "notification_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "notification_type" VARCHAR(60) NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "message" TEXT NOT NULL,
  "target_path" VARCHAR(255),
  "deduplication_key" VARCHAR(160),
  "read_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_notifications_pkey" PRIMARY KEY ("notification_id")
);

CREATE UNIQUE INDEX "staff_notifications_user_id_deduplication_key_key" ON "staff_notifications"("user_id", "deduplication_key");
CREATE INDEX "staff_notifications_user_id_read_at_created_at_idx" ON "staff_notifications"("user_id", "read_at", "created_at");

ALTER TABLE "staff_notifications" ADD CONSTRAINT "staff_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
