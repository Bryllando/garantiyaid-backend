import test from "node:test";
import assert from "node:assert/strict";
import {
  changeOwnPasswordSchema,
  confirmTotpReplacementSchema,
  loginSchema,
  reauthenticateAccountSchema,
  updateOwnProfileSchema,
} from "../src/modules/auth/auth.schemas.js";

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

test("account-security actions require a password, one TOTP code, and strict payloads", () => {
  const reauthentication = {
    currentPassword: "A current private password",
    totpCode: "123456",
  };

  assert.deepEqual(reauthenticateAccountSchema.parse(reauthentication), reauthentication);
  assert.equal(reauthenticateAccountSchema.safeParse({ currentPassword: "password" }).success, false);
  assert.equal(changeOwnPasswordSchema.safeParse({
    ...reauthentication,
    newPassword: "A different private password",
  }).success, true);
  assert.equal(confirmTotpReplacementSchema.safeParse({
    replacementToken: "signed-token",
    code: "654321",
  }).success, true);
  assert.deepEqual(updateOwnProfileSchema.parse({
    email: " Staff@Example.com ",
    contactNumber: "",
  }), {
    email: "staff@example.com",
    contactNumber: null,
  });
  assert.equal(
    updateOwnProfileSchema.parse({ contactNumber: "0917 123 4567" }).contactNumber,
    "+639171234567",
  );
  assert.equal(updateOwnProfileSchema.safeParse({ contactNumber: "092039149" }).success, false);
  assert.equal(updateOwnProfileSchema.safeParse({ fullName: "Not self-service" }).success, false);
});
