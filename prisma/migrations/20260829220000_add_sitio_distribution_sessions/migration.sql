ALTER TABLE "beneficiaries"
ADD COLUMN "sitio_purok" VARCHAR(120);

ALTER TABLE "distribution_slots"
ADD COLUMN "session_id" UUID,
ADD COLUMN "session_label" VARCHAR(120),
ADD COLUMN "location" VARCHAR(200),
ADD COLUMN "service_areas" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "distribution_slots" AS slot
SET
  "session_id" = slot."distribution_id",
  "session_label" = 'Main session',
  "location" = distribution."location"
FROM "distributions" AS distribution
WHERE distribution."distribution_id" = slot."distribution_id";

ALTER TABLE "distribution_slots"
ALTER COLUMN "session_id" SET NOT NULL,
ALTER COLUMN "session_label" SET NOT NULL,
ALTER COLUMN "location" SET NOT NULL;

CREATE INDEX "distribution_slots_distribution_id_session_id_slot_start_idx"
ON "distribution_slots"("distribution_id", "session_id", "slot_start");
