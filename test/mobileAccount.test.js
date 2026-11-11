import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import app from "../src/app.js";
import prisma from "../src/lib/prisma.js";
import { env } from "../src/config/env.js";
import { signAccessToken } from "../src/modules/auth/auth.service.js";
import { verifyMobileAccessToken } from "../src/modules/beneficiaries/mobileAccount.auth.js";
import { apiRateLimitKey } from "../src/middleware/rateLimit.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const barangayId = "11111111-1111-4111-8111-111111111111";
const beneficiaryId = "22222222-2222-4222-8222-222222222222";
const accountId = "33333333-3333-4333-8333-333333333333";
const actor = { userId: "44444444-4444-4444-8444-444444444444", role: "BARANGAY_FACILITATOR", barangayId, isActive: true };
const profile = { firstName: "Maria", lastName: "Fixture", middleName: null, birthDate: "1990-01-12", barangayId };
const pending = () => ({ ...profile, birthDate: new Date(profile.birthDate), accountId, revision: 1, status: "PENDING", beneficiaryId: null });
const mobileToken = (subject = "mobile-fixture", claims = {}) => jwt.sign({ type: "beneficiary", ...claims }, privateKey, { algorithm: "RS256", subject, issuer: env.mobileAuthIssuer, audience: env.mobileAuthAudience, expiresIn: "10m" });
const headers = token => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
const decision = (overrides = {}) => ({ decision: "LINK", beneficiaryId, confirmedIdentity: true, revision: 1, note: "Official identity and account ownership checked.", ...overrides });
function replace(t, target, key, value) { const old = target[key]; target[key] = value; t.after(() => { target[key] = old; }); }
let server, origin;
test.before(async () => { server = app.listen(0, "127.0.0.1"); await once(server, "listening"); origin = `http://127.0.0.1:${server.address().port}/api/v1`; });
test.after(async () => { await new Promise(resolve => server.close(resolve)); });
test.beforeEach(t => {
  replace(t, env, "mobileAuthPublicKey", publicKey.export({ type: "spki", format: "pem" }));
  replace(t, prisma.user, "findUnique", async () => actor);
  replace(t, prisma.staffSession, "findFirst", async () => ({ sessionId: "fixture" }));
});
async function post(path, token, body) { return fetch(`${origin}${path}`, { method: "POST", headers: headers(token), body: JSON.stringify(body) }); }

test("only short-lived RS256 beneficiary assertions from the trusted issuer are accepted", () => {
  assert.equal(verifyMobileAccessToken(mobileToken()).subject, "mobile-fixture");
  for (const token of [signAccessToken(actor), mobileToken("fixture", { type: "staff" }),
    jwt.sign({ type: "beneficiary" }, privateKey, { algorithm: "RS256", subject: "fixture", issuer: "untrusted", audience: env.mobileAuthAudience, expiresIn: "10m" }),
    jwt.sign({ type: "beneficiary" }, privateKey, { algorithm: "RS256", subject: "fixture", issuer: env.mobileAuthIssuer, audience: env.mobileAuthAudience, expiresIn: "1h" }),
    jwt.sign({ type: "beneficiary", iat: Math.floor(Date.now() / 1000) + 600 }, privateKey, { algorithm: "RS256", subject: "fixture", issuer: env.mobileAuthIssuer, audience: env.mobileAuthAudience, expiresIn: "10m" }),
  ]) assert.throws(() => verifyMobileAccessToken(token), { code: "INVALID_MOBILE_TOKEN" });
});

test("beneficiaries on the same barangay connection receive separate verified API quotas", () => {
  const request = token => ({ ip: "127.0.0.1", get: () => `Bearer ${token}` });
  assert.notEqual(apiRateLimitKey(request(mobileToken("one"))), apiRateLimitKey(request(mobileToken("two"))));
  assert.ok(apiRateLimitKey(request("invalid")).startsWith("ip:"));
});

test("integration stays disabled without a verification key and mobile tokens never authorize staff routes", async t => {
  assert.equal((await fetch(`${origin}/mobile-account-requests`, { headers: headers(mobileToken()) })).status, 401);
  replace(t, env, "mobileAuthPublicKey", undefined);
  assert.equal((await fetch(`${origin}/mobile/me`, { headers: headers("fixture") })).status, 503);
  assert.equal((await fetch(`${origin}/mobile/me`)).status, 401);
});

test("DSWD cannot approve links; facilitators see only their assigned barangay requests", async t => {
  const dswd = { ...actor, role: "DSWD_STAFF" };
  replace(t, prisma.user, "findUnique", async () => dswd);
  assert.equal((await post(`/mobile-account-requests/${accountId}/decision`, signAccessToken(dswd), decision())).status, 403);
  prisma.user.findUnique = async () => actor;
  replace(t, prisma.mobileBeneficiaryAccount, "findMany", async query => { assert.deepEqual(query.where, { status: "PENDING", barangayId }); return []; });
  replace(t, prisma.mobileBeneficiaryAccount, "count", async () => 0);
  const response = await fetch(`${origin}/mobile-account-requests`, { headers: headers(signAccessToken(actor)) });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
});

test("mobile requests use the authenticated subject, audit once, and never create a beneficiary", async t => {
  let account = null, audits = 0, creates = 0;
  const tx = {
    mobileBeneficiaryAccount: {
      findUnique: async query => { assert.deepEqual(query.where.issuer_subject, { issuer: env.mobileAuthIssuer, subject: "mobile-fixture" }); return account; },
      create: async ({ data }) => { creates++; account = { ...pending(), ...data }; return account; },
    },
    beneficiary: { create: () => assert.fail("Mobile intake must not create another person") },
    auditLog: { create: async ({ data }) => { audits++; assert.equal(data.actorType, "BENEFICIARY"); } },
  };
  replace(t, prisma.barangay, "findFirst", async () => ({ barangayId }));
  replace(t, prisma, "$transaction", callback => callback(tx));
  const forged = await post("/mobile/link-request", mobileToken(), { ...profile, subject: "someone-else" });
  assert.equal(forged.status, 400);
  for (let n = 0; n < 2; n++) assert.equal((await post("/mobile/link-request", mobileToken(), profile)).status, 200);
  assert.equal(creates, 1); assert.equal(audits, 1);
});

test("mobile self lookup returns only its linked active person and no staff matching directory", async t => {
  replace(t, prisma.mobileBeneficiaryAccount, "findUnique", async query => {
    assert.equal(query.where.issuer_subject.subject, "mobile-fixture");
    assert.equal(query.select.subject, undefined);
    return { ...pending(), status: "LINKED", beneficiaryId };
  });
  replace(t, prisma.beneficiary, "findFirst", async query => {
    assert.deepEqual(query.where, { beneficiaryId, status: "ACTIVE" });
    assert.equal(query.select.passwordHash, undefined); assert.equal(query.select.philsysNumber, undefined);
    return { beneficiaryId };
  });
  assert.equal((await fetch(`${origin}/mobile/me`, { headers: headers(mobileToken()) })).status, 200);
});

test("mobile registration can choose an active barangay without accessing staff or beneficiary directories", async t => {
  replace(t, prisma.barangay, "findMany", async query => {
    assert.deepEqual(query.where, { isActive: true }); assert.equal(query.skip, 20); assert.equal(query.take, 20);
    assert.deepEqual(Object.keys(query.select).sort(), ["barangayId", "barangayName", "city", "province"]);
    return [{ barangayId, barangayName: "Fixture" }];
  });
  replace(t, prisma.barangay, "count", async () => 21);
  const response = await fetch(`${origin}/mobile/barangays?page=2`, { headers: headers(mobileToken()) });
  assert.equal(response.status, 200); assert.equal((await response.json()).data.pagination.totalPages, 2);
});

test("a conditional decision that loses a concurrent update cannot write an audit or approve the account", async t => {
  replace(t, prisma, "$transaction", callback => callback({
    mobileBeneficiaryAccount: { findFirst: async () => pending(), updateMany: async () => ({ count: 0 }) },
    beneficiary: { findFirst: async () => ({ beneficiaryId, barangayId }) },
    auditLog: { create: () => assert.fail("A lost update must not record an approval") },
  }));
  assert.equal((await post(`/mobile-account-requests/${accountId}/decision`, signAccessToken(actor), decision())).status, 409);
});

test("approval links the imported person without overwriting identity, documents or enrollment", async t => {
  let account = pending(), writes = 0, audits = [];
  const tx = {
    mobileBeneficiaryAccount: {
      findFirst: async ({ where }) => { assert.equal(where.barangayId, barangayId); return account; },
      updateMany: async ({ where, data }) => { assert.equal(where.revision, 1); writes++; account = { ...account, ...data, revision: 2 }; return { count: 1 }; },
      findUniqueOrThrow: async () => account,
    },
    beneficiary: { findFirst: async ({ where }) => { assert.deepEqual(where, { beneficiaryId, status: "ACTIVE", barangayId }); return { beneficiaryId, barangayId }; } },
    auditLog: { create: async ({ data }) => audits.push(data) },
  };
  replace(t, prisma, "$transaction", callback => callback(tx));
  const response = await post(`/mobile-account-requests/${accountId}/decision`, signAccessToken(actor), decision());
  assert.equal(response.status, 200); assert.equal((await response.json()).data.account.beneficiaryId, beneficiaryId);
  assert.equal(writes, 1); assert.equal(audits[0].action, "MOBILE_ACCOUNT_LINKED");
  assert.equal((await post(`/mobile-account-requests/${accountId}/decision`, signAccessToken(actor), decision())).status, 409);
  assert.equal(writes, 1);
});

test("missing confirmation, out-of-scope records, stale revisions and another account's person are blocked", async t => {
  assert.equal((await post(`/mobile-account-requests/${accountId}/decision`, signAccessToken(actor), { ...decision(), confirmedIdentity: false })).status, 400);
  let account = pending(), person = null, writeConflict = false;
  const tx = {
    mobileBeneficiaryAccount: { findFirst: async () => account, updateMany: async () => { if (writeConflict) throw Object.assign(new Error("unique"), { code: "P2002" }); assert.fail("Invalid decisions must not write"); } },
    beneficiary: { findFirst: async () => person },
  };
  replace(t, prisma, "$transaction", callback => callback(tx));
  const send = body => post(`/mobile-account-requests/${accountId}/decision`, signAccessToken(actor), body);
  assert.equal((await send(decision({ revision: 2 }))).status, 409);
  assert.equal((await send(decision())).status, 404);
  person = { beneficiaryId, barangayId: actor.userId };
  assert.equal((await send(decision())).status, 409);
  person.barangayId = barangayId; writeConflict = true;
  const occupied = await send(decision()); assert.equal(occupied.status, 409); assert.equal((await occupied.json()).error.code, "BENEFICIARY_ALREADY_LINKED");
  account = null;
  assert.equal((await send(decision())).status, 404);
});

test("correction records a reason, permits an owned resubmission and never unlinks an approved account", async t => {
  let account = pending(), audits = [];
  const tx = {
    mobileBeneficiaryAccount: {
      findFirst: async () => account, findUnique: async () => account, findUniqueOrThrow: async () => account,
      updateMany: async ({ data }) => { account = { ...account, ...data, revision: account.revision + 1 }; return { count: 1 }; },
    },
    auditLog: { create: async ({ data }) => audits.push(data) },
  };
  replace(t, prisma, "$transaction", callback => callback(tx));
  replace(t, prisma.barangay, "findFirst", async () => ({ barangayId }));
  const rejected = await post(`/mobile-account-requests/${accountId}/decision`, signAccessToken(actor), { decision: "REJECT", revision: 1, note: "Please bring the correct birth record." });
  assert.equal(rejected.status, 200); assert.equal(account.status, "REJECTED"); assert.equal(account.beneficiaryId, null);
  assert.equal((await post("/mobile/link-request", mobileToken(), { ...profile, revision: 2 })).status, 200);
  assert.equal(account.status, "PENDING"); assert.equal(account.reviewNote, null); assert.equal(audits.length, 2);
  account.status = "LINKED"; account.beneficiaryId = beneficiaryId;
  assert.equal((await post("/mobile/link-request", mobileToken(), { ...profile, revision: 3 })).status, 409);
});
