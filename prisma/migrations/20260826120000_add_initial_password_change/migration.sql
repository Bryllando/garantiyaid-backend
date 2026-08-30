ALTER TABLE "users"
ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "users"
ALTER COLUMN "must_change_password" SET DEFAULT true;
