import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveStaffLoginLookup,
  staffLoginMethodAllowed,
} from "../src/modules/auth/auth.service.js";

test("employee ID login is normalized for a unique lookup", () => {
  assert.deepEqual(resolveStaffLoginLookup(" dswd-001 "), {
    OR: [
      { employeeId: "DSWD-001" },
      { username: "dswd-001" },
    ],
  });
});

test("username login is normalized for a unique lookup", () => {
  assert.deepEqual(resolveStaffLoginLookup(" System.Admin "), {
    OR: [
      { employeeId: "SYSTEM.ADMIN" },
      { username: "system.admin" },
    ],
  });
});

test("official staff IDs work for every staff role and allowed usernames remain valid", () => {
  const admin = { role: "SYSTEM_ADMIN", employeeId: "ADMIN-001", username: "system.admin" };
  const dswd = { role: "DSWD_STAFF", employeeId: "DSWD-0001", username: null };
  const barangay = {
    role: "BARANGAY_FACILITATOR",
    employeeId: "BSTF-0001",
    username: "barangay.staff",
  };

  assert.equal(staffLoginMethodAllowed(admin, "admin-001"), true);
  assert.equal(staffLoginMethodAllowed(admin, "system.admin"), true);
  assert.equal(staffLoginMethodAllowed(dswd, "dswd-0001"), true);
  assert.equal(staffLoginMethodAllowed(dswd, "barangay.staff"), false);
  assert.equal(staffLoginMethodAllowed(barangay, "barangay.staff"), true);
  assert.equal(staffLoginMethodAllowed(barangay, "BSTF-0001"), true);
});
