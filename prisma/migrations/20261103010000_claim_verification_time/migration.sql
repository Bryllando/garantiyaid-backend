-- Historical updated_at values do not establish when verification completed.
ALTER TABLE "claims" ADD COLUMN "verified_at" TIMESTAMPTZ(6);
