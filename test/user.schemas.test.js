import test from "node:test";
import assert from "node:assert/strict";
import {
  createStaffUserSchema,
  deleteStaffUserSchema,
  resetStaffTotpSchema,
  staffUserListQuerySchema,
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

test("staff contact numbers normalize Philippine mobile formats and reject invalid values", () => {
  assert.equal(
    createStaffUserSchema.parse(validStaff({ contactNumber: "0917 123 4567" })).contactNumber,
    "+639171234567",
  );
  assert.equal(updateStaffUserSchema.parse({ contactNumber: "+639171234567" }).contactNumber, "+639171234567");
  assert.equal(updateStaffUserSchema.parse({ contactNumber: "" }).contactNumber, null);
  assert.equal(createStaffUserSchema.safeParse(validStaff({ contactNumber: "092039149" })).success, false);
  assert.equal(createStaffUserSchema.safeParse(validStaff({ contactNumber: "12345678901" })).success, false);
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

test("staff deletion requires one strict typed confirmation", () => {
  assert.deepEqual(deleteStaffUserSchema.parse({ confirmation: " DELETE DSWD-0002 " }), {
    confirmation: "DELETE DSWD-0002",
  });
  assert.equal(deleteStaffUserSchema.safeParse({ confirmation: "" }).success, false);
  assert.equal(deleteStaffUserSchema.safeParse({ confirmation: "DELETE DSWD-0002", extra: true }).success, false);
});

test("staff list can explicitly show archived accounts", () => {
  assert.equal(staffUserListQuerySchema.parse({}).archived, "false");
  assert.equal(staffUserListQuerySchema.parse({ archived: "true" }).archived, "true");
  assert.equal(staffUserListQuerySchema.safeParse({ archived: "yes" }).success, false);
});
