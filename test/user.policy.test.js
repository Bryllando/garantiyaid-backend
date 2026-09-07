import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertStaffAccountCanBeRemoved,
  formatGeneratedStaffId,
  generateStaffId,
  generateTemporaryPassword,
  getStaffRemovalMode,
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

test("inactive staff accounts are deleted or archived according to operational history", () => {
  const targetUser = { userId: "staff-user", employeeId: "DSWD-0002", isActive: false };
  assert.equal(getStaffRemovalMode({ verifiedClaims: 1 }), "ARCHIVE");
  assert.equal(getStaffRemovalMode({ verifiedClaims: 0 }), "DELETE");
  assert.doesNotThrow(() => assertStaffAccountCanBeRemoved({
    actorUserId: "admin-user",
    confirmation: "DELETE DSWD-0002",
    removalMode: "DELETE",
    targetUser,
  }));
  assert.doesNotThrow(() => assertStaffAccountCanBeRemoved({
    actorUserId: "admin-user",
    confirmation: "ARCHIVE DSWD-0002",
    removalMode: "ARCHIVE",
    targetUser,
  }));
  assert.throws(
    () => assertStaffAccountCanBeRemoved({
      actorUserId: "admin-user",
      confirmation: "DELETE DSWD-0002",
      removalMode: "DELETE",
      targetUser: { ...targetUser, isActive: true },
    }),
    (error) => error.code === "STAFF_ACCOUNT_MUST_BE_INACTIVE",
  );
  assert.throws(
    () => assertStaffAccountCanBeRemoved({
      actorUserId: "staff-user",
      confirmation: "DELETE DSWD-0002",
      removalMode: "DELETE",
      targetUser,
    }),
    (error) => error.code === "SELF_ACCOUNT_REMOVAL_FORBIDDEN",
  );
  assert.throws(
    () => assertStaffAccountCanBeRemoved({
      actorUserId: "admin-user",
      confirmation: "DELETE DSWD-0002",
      removalMode: "ARCHIVE",
      targetUser,
    }),
    (error) => error.code === "STAFF_REMOVAL_CONFIRMATION_MISMATCH",
  );
});

test("deleted staff audit entries retain a valid explicit actor type", () => {
  const controller = readFileSync(new URL("../src/modules/users/user.controller.js", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../prisma/migrations/20260901161000_allow_deleted_staff_audit_actor/migration.sql", import.meta.url), "utf8");
  assert.match(controller, /actorType: "DELETED_STAFF"/);
  assert.match(migration, /'DELETED_STAFF'/);
  assert.match(migration, /"user_id" IS NULL/);
});

test("archived staff accounts have an audited inactive restore path", () => {
  const controller = readFileSync(new URL("../src/modules/users/user.controller.js", import.meta.url), "utf8");
  assert.match(controller, /action: "STAFF_ACCOUNT_RESTORED"/);
  assert.match(controller, /data: \{ archivedAt: null, isActive: false \}/);
});
