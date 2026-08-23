import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("beneficiary API selection excludes mobile-auth and wallet fields", async () => {
  process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/garantiyaid_test";
  const { beneficiarySelect } = await import(
    "../src/modules/beneficiaries/beneficiary.service.js"
  );

  assert.equal(Object.hasOwn(beneficiarySelect, "passwordHash"), false);
  assert.equal(Object.hasOwn(beneficiarySelect, "isVerified"), false);
  assert.equal(Object.hasOwn(beneficiarySelect, "walletAccount"), false);
});

test("beneficiary creation does not automatically create a wallet", async () => {
  const controllerSource = await readFile(
    new URL("../src/modules/beneficiaries/beneficiary.controller.js", import.meta.url),
    "utf8",
  );

  assert.equal(controllerSource.includes("walletAccount.create"), false);
  assert.equal(controllerSource.includes("walletAccount:"), false);
});
