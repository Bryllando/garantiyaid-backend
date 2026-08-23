import test from "node:test";
import assert from "node:assert/strict";
import { resolveStaffUserUpdate } from "../src/modules/users/user.service.js";

const barangayId = "11111111-1111-4111-8111-111111111111";

test("changing a facilitator to DSWD clears username and barangay assignment", () => {
  const result = resolveStaffUserUpdate({
    role: "BARANGAY_FACILITATOR",
    username: "barangay.staff",
    barangayId,
  }, {
    role: "DSWD_STAFF",
  });

  assert.deepEqual(result, {
    role: "DSWD_STAFF",
    barangayId: null,
    username: null,
  });
});

test("changing DSWD Staff to System Administrator requires a username", () => {
  assert.throws(
    () => resolveStaffUserUpdate({
      role: "DSWD_STAFF",
      username: null,
      barangayId: null,
    }, {
      role: "SYSTEM_ADMIN",
    }),
    (error) => error.code === "USERNAME_REQUIRED",
  );
});

test("DSWD Staff cannot be assigned a username", () => {
  assert.throws(
    () => resolveStaffUserUpdate({
      role: "DSWD_STAFF",
      username: null,
      barangayId: null,
    }, {
      username: "dswd.user",
    }),
    (error) => error.code === "USERNAME_NOT_ALLOWED",
  );
});
