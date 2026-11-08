-- Historical events and handovers have no reliable quantity to backfill.
ALTER TABLE "distributions"
  ADD COLUMN "package_name" VARCHAR(150),
  ADD COLUMN "package_unit" VARCHAR(30),
  ADD COLUMN "package_quantity" INTEGER,
  ADD CONSTRAINT "distribution_package_complete" CHECK (
    ("package_name" IS NULL AND "package_unit" IS NULL AND "package_quantity" IS NULL)
    OR ("delivery_mode" = 'PHYSICAL_GOODS' AND "package_name" IS NOT NULL
      AND "package_unit" IS NOT NULL AND "package_quantity" IS NOT NULL
      AND LENGTH(TRIM("package_name")) > 0 AND LENGTH(TRIM("package_unit")) > 0
      AND "package_quantity" BETWEEN 1 AND 10000)
  );

ALTER TABLE "claims"
  ADD COLUMN "released_package_name" VARCHAR(150),
  ADD COLUMN "released_package_unit" VARCHAR(30),
  ADD COLUMN "released_quantity" INTEGER,
  ADD CONSTRAINT "claim_package_complete" CHECK (
    ("released_package_name" IS NULL AND "released_package_unit" IS NULL AND "released_quantity" IS NULL)
    OR ("release_method" = 'PHYSICAL_GOODS' AND "release_method" IS NOT NULL
      AND "released_at" IS NOT NULL AND "released_by" IS NOT NULL
      AND "released_package_name" IS NOT NULL AND "released_package_unit" IS NOT NULL
      AND LENGTH(TRIM("released_package_name")) > 0 AND LENGTH(TRIM("released_package_unit")) > 0
      AND "released_quantity" IS NOT NULL AND "released_quantity" BETWEEN 1 AND 10000)
  );
