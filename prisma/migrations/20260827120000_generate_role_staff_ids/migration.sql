CREATE SEQUENCE "dswd_staff_id_seq" AS BIGINT START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
CREATE SEQUENCE "barangay_staff_id_seq" AS BIGINT START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

SELECT setval(
  'dswd_staff_id_seq',
  GREATEST(
    COALESCE((
      SELECT MAX(CAST(SUBSTRING("employee_id" FROM '^DSWD-([0-9]+)$') AS BIGINT))
      FROM "users"
      WHERE "role" = 'DSWD_STAFF' AND "employee_id" ~ '^DSWD-[0-9]+$'
    ), 0) + 1,
    1
  ),
  false
);

SELECT setval(
  'barangay_staff_id_seq',
  GREATEST(
    COALESCE((
      SELECT MAX(CAST(SUBSTRING("employee_id" FROM '^BSTF-([0-9]+)$') AS BIGINT))
      FROM "users"
      WHERE "role" = 'BARANGAY_FACILITATOR' AND "employee_id" ~ '^BSTF-[0-9]+$'
    ), 0) + 1,
    1
  ),
  false
);
