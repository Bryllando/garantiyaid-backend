ALTER TABLE "distribution_slots"
ADD CONSTRAINT "distribution_slots_capacity_check"
CHECK ("capacity" BETWEEN 1 AND 1000);

ALTER TABLE "distribution_slots"
ADD CONSTRAINT "distribution_slots_time_range_check"
CHECK ("slot_end" > "slot_start");

CREATE UNIQUE INDEX "distribution_slots_distribution_id_slot_start_key"
ON "distribution_slots"("distribution_id", "slot_start");

CREATE INDEX "distribution_slots_distribution_id_slot_status_slot_start_idx"
ON "distribution_slots"("distribution_id", "slot_status", "slot_start");
