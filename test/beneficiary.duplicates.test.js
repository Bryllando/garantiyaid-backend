import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import app from "../src/app.js";
import prisma from "../src/lib/prisma.js";
import { signAccessToken } from "../src/modules/auth/auth.service.js";
import { assertNoPotentialDuplicateBeneficiary } from "../src/modules/beneficiaries/beneficiary.service.js";

const barangayId = "11111111-1111-4111-8111-111111111111";
const beneficiaryId = "22222222-2222-4222-8222-222222222222";
const actor = { userId: "33333333-3333-4333-8333-333333333333", role: "BARANGAY_FACILITATOR", barangayId, isActive: true };
const person = { firstName: "Maria", lastName: "Fixture", birthDate: "1990-01-12", sex: "FEMALE", address: "Test street" };
let server, origin;
function replace(t, target, key, implementation) {
  const previous = target[key];
  target[key] = implementation;
  t.after(() => { target[key] = previous; });
}

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}/api/v1/beneficiaries`;
});
test.after(async () => { await new Promise(resolve => server.close(resolve)); });

test("new contact details cannot bypass an existing beneficiary identity during registration", async t => {
  replace(t, prisma.user, "findUnique", async () => actor);
  replace(t, prisma.staffSession, "findFirst", async () => ({ sessionId: "fixture-session" }));
  replace(t, prisma.barangay, "findUnique", async () => ({ barangayId, isActive: true }));
  let checks = 0;
  replace(t, prisma.beneficiary, "findFirst", async query => {
    checks++;
    assert.equal(query.where.firstName.equals, person.firstName);
    assert.equal(query.where.barangayId, barangayId);
    return { beneficiaryId };
  });
  replace(t, prisma, "$transaction", async () => { assert.fail("A duplicate must not reach a write transaction"); });
  for (const details of [{}, { email: "new@example.test" }, { philsysNumber: "TEST-NEW-ID" }, { email: "new@example.test", philsysNumber: "TEST-NEW-ID" }]) {
    const response = await fetch(origin, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${signAccessToken(actor)}` },
      body: JSON.stringify({ ...person, ...details }),
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.error.code, "POSSIBLE_DUPLICATE_BENEFICIARY");
    assert.ok(!JSON.stringify(body).includes(beneficiaryId), "Duplicate checks must not disclose another record's identity");
  }
  assert.equal(checks, 4);
});

test("editing a record excludes itself but still checks for another matching beneficiary", async t => {
  let otherRecordExists = false;
  replace(t, prisma.beneficiary, "findFirst", async query => {
    assert.deepEqual(query.where.beneficiaryId, { not: beneficiaryId });
    return otherRecordExists ? { beneficiaryId: "another-record" } : null;
  });
  const input = { ...person, beneficiaryId, barangayId, email: "changed@example.test" };
  await assertNoPotentialDuplicateBeneficiary(input);
  otherRecordExists = true;
  await assert.rejects(assertNoPotentialDuplicateBeneficiary(input), { code: "POSSIBLE_DUPLICATE_BENEFICIARY" });
});
