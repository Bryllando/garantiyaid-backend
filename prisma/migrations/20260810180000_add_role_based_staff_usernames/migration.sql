ALTER TABLE "users" ADD COLUMN "username" VARCHAR(30);

UPDATE "users"
SET "username" = 'system.admin'
WHERE "employee_id" = 'ADMIN-001' AND "role" = 'SYSTEM_ADMIN';

UPDATE "users"
SET "username" = 'barangay.staff'
WHERE "employee_id" = 'BSTF-001' AND "role" = 'BARANGAY_FACILITATOR';

CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

ALTER TABLE "users"
ADD CONSTRAINT "users_role_username_check"
CHECK (
  ("role" = 'DSWD_STAFF' AND "username" IS NULL)
  OR
  (
    "role" IN ('SYSTEM_ADMIN', 'BARANGAY_FACILITATOR')
    AND "username" IS NOT NULL
    AND "username" = LOWER("username")
    AND "username" ~ '^[a-z][a-z0-9._]{3,29}$'
  )
);
