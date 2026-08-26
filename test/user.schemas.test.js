import test from "node:test";
import assert from "node:assert/strict";
import {
  createStaffUserSchema,
  resetStaffTotpSchema,
  updateStaffUserSchema,
} from "../src/modules/users/user.schemas.js";

function validStaff(overrides = {}) {
  return {
    employeeId: "staff-001",
    username: "staff.user",
    fullName: "Staff User",
    email: "staff@example.com",
    password: "TemporaryPassword123",
    role: "SYSTEM_ADMIN",
    ...overrides,
  };
}

test("System Administrator receives a normalized username and employee ID", () => {
  const result = createStaffUserSchema.parse(validStaff({
    username: " System.Admin ",
  }));

  assert.equal(result.employeeId, "STAFF-001");
  assert.equal(result.username, "system.admin");
});

test("System Administrator requires a username", () => {
  const { username: ignored, ...payload } = validStaff();
  assert.equal(createStaffUserSchema.safeParse(payload).success, false);
});

test("DSWD Staff uses an official employee ID and cannot have a username", () => {
  assert.equal(createStaffUserSchema.safeParse(validStaff({
    role: "DSWD_STAFF",
    username: undefined,
  })).success, true);

  assert.equal(createStaffUserSchema.safeParse(validStaff({
    role: "DSWD_STAFF",
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

test("TOTP reset requires all three identity-verification attestations", () => {
  const verified = {
    staffIdVerified: true,
    validIdVerified: true,
    supervisorConfirmed: true,
  };

  assert.deepEqual(resetStaffTotpSchema.parse(verified), verified);
  assert.equal(resetStaffTotpSchema.safeParse({ ...verified, validIdVerified: false }).success, false);
});
