import test from "node:test";
import assert from "node:assert/strict";
import {
  createStaffUserSchema,
  resetStaffTotpSchema,
  updateStaffUserSchema,
} from "../src/modules/users/user.schemas.js";

function validStaff(overrides = {}) {
  return {
    fullName: "Staff User",
    email: "staff@example.com",
    role: "DSWD_STAFF",
    ...overrides,
  };
}

test("routine account creation accepts only system-generated staff IDs", () => {
  assert.equal(createStaffUserSchema.safeParse(validStaff()).success, true);
  assert.equal(createStaffUserSchema.safeParse(validStaff({ employeeId: "DSWD-9999" })).success, false);
  assert.equal(createStaffUserSchema.safeParse(validStaff({ password: "barangay1234" })).success, false);
  assert.equal(createStaffUserSchema.safeParse(validStaff({
    role: "SYSTEM_ADMIN",
    username: "system.admin",
  })).success, false);
});

test("DSWD Staff uses its generated Staff ID and cannot have a username", () => {
  assert.equal(createStaffUserSchema.safeParse(validStaff({
    username: "dswd.user",
  })).success, false);
});

test("Barangay Facilitator requires both username and barangay assignment", () => {
  const barangayId = "11111111-1111-4111-8111-111111111111";
  assert.equal(createStaffUserSchema.safeParse(validStaff({
    role: "BARANGAY_FACILITATOR",
    username: "barangay.staff",
    barangayId,
  })).success, true);

  assert.equal(createStaffUserSchema.safeParse(validStaff({
    role: "BARANGAY_FACILITATOR",
    username: undefined,
    barangayId,
  })).success, false);
});

test("staff username updates normalize case and allow an explicit clear", () => {
  assert.equal(updateStaffUserSchema.parse({ username: " New.Admin " }).username, "new.admin");
  assert.equal(updateStaffUserSchema.parse({ username: "" }).username, null);
});

test("staff contact updates allow an explicit clear", () => {
  assert.equal(updateStaffUserSchema.parse({ contactNumber: "" }).contactNumber, null);
});

test("staff role is immutable after account creation", () => {
  assert.equal(updateStaffUserSchema.safeParse({ role: "DSWD_STAFF" }).success, false);
});

test("TOTP reset requires all three identity-verification attestations", () => {
  const verified = {
    staffIdVerified: true,
    validIdVerified: true,
    supervisorConfirmed: true,
  };

  assert.deepEqual(resetStaffTotpSchema.parse(verified), verified);
  assert.equal(resetStaffTotpSchema.safeParse({ ...verified, validIdVerified: false }).success, false);
});
