import test from "node:test";
import assert from "node:assert/strict";
import { loginSchema } from "../src/modules/auth/auth.schemas.js";

test("staff login accepts an employee ID identifier", () => {
  const result = loginSchema.parse({
    identifier: "  dswd-001  ",
    password: "TemporaryPassword123",
    totpCode: "123456",
  });

  assert.deepEqual(result, {
    identifier: "dswd-001",
    password: "TemporaryPassword123",
    totpCode: "123456",
  });
});

test("staff login accepts a username identifier", () => {
  const result = loginSchema.parse({
    identifier: " system.admin ",
    password: "TemporaryPassword123",
  });

  assert.equal(result.identifier, "system.admin");
});

test("staff login rejects email addresses and the retired email property", () => {
  assert.equal(loginSchema.safeParse({
    identifier: "staff@example.com",
    password: "TemporaryPassword123",
  }).success, false);

  assert.equal(loginSchema.safeParse({
    email: "staff@example.com",
    password: "TemporaryPassword123",
  }).success, false);
});

test("staff login requires a login identifier", () => {
  assert.equal(loginSchema.safeParse({
    password: "TemporaryPassword123",
  }).success, false);
});
