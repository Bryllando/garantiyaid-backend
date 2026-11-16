-- Existing beneficiary text is retained for staff review against confirmed local records.
ALTER TABLE "barangays" ADD COLUMN "service_areas" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
