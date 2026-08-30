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

test("staff login accepts one recovery code and rejects mixed second factors", () => {
  const result = loginSchema.parse({
    identifier: "staff-001",
    password: "TemporaryPassword123",
    recoveryCode: "abcd-1234-ef56-7890",
  });

  assert.equal(result.recoveryCode, "ABCD-1234-EF56-7890");
  assert.equal(loginSchema.safeParse({
    identifier: "staff-001",
    password: "TemporaryPassword123",
    totpCode: "123456",
    recoveryCode: "ABCD-1234-EF56-7890",
  }).success, false);
});

test("initial password change accepts a new staff password without a second factor", () => {
  const result = loginSchema.parse({
    identifier: "staff-001",
    password: "TemporaryPassword123",
    newPassword: "A different private password 456",
  });

  assert.equal(result.newPassword, "A different private password 456");
  assert.equal(loginSchema.safeParse({
    ...result,
    totpCode: "123456",
  }).success, false);
  assert.equal(loginSchema.safeParse({
    identifier: "staff-001",
    password: "TemporaryPassword123",
    newPassword: "too-short",
  }).success, false);
});
