import test from "node:test";
import assert from "node:assert/strict";
import {
  formatGeneratedStaffId,
  generateStaffId,
  generateTemporaryPassword,
  resolveStaffUserUpdate,
} from "../src/modules/users/user.service.js";

const barangayId = "11111111-1111-4111-8111-111111111111";

test("temporary staff passwords are server-generated and unpredictable", () => {
  const first = generateTemporaryPassword();
  const second = generateTemporaryPassword();

  assert.match(first, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(first, second);
});

test("generated Staff IDs use permanent role prefixes and four-digit minimum padding", async () => {
  assert.equal(formatGeneratedStaffId("DSWD_STAFF", 1n), "DSWD-0001");
  assert.equal(formatGeneratedStaffId("BARANGAY_FACILITATOR", 42n), "BSTF-0042");
  assert.equal(formatGeneratedStaffId("DSWD_STAFF", 10_000n), "DSWD-10000");

  const database = { $queryRaw: async () => [{ value: 7n }] };
  assert.equal(await generateStaffId("DSWD_STAFF", database), "DSWD-0007");
  assert.equal(await generateStaffId("BARANGAY_FACILITATOR", database), "BSTF-0007");
});

test("staff roles cannot change after a role-based Staff ID is assigned", () => {
  assert.throws(
    () => resolveStaffUserUpdate({
      role: "DSWD_STAFF",
      username: null,
      barangayId: null,
    }, {
      role: "BARANGAY_FACILITATOR",
    }),
    (error) => error.code === "STAFF_ROLE_IMMUTABLE",
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
