import test from "node:test";
import assert from "node:assert/strict";
import { resolveStaffLoginLookup } from "../src/modules/auth/auth.service.js";

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
