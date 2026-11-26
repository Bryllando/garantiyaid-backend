import test from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("existing beneficiary → phone login → admin identity approval → one wallet credit", {
  skip: process.env.RUN_MOBILE_CLAIM_INTEGRATION !== "1",
}, async t => {
  // Uses synthetic records in a disposable, migrated database and a transport fixture for the face service.
  const db = new URL(process.env.DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1"].includes(db.hostname) && db.pathname === "/garantiyaid_mobile_test");
  const uploadRoot = await mkdtemp(path.join(tmpdir(), "garantiyaid-mobile-test-"));
  process.env.UPLOAD_ROOT = uploadRoot;
  const { default: app } = await import("../src/app.js");
  const { default: prisma } = await import("../src/lib/prisma.js");
  const { issueAccessToken } = await import("../src/modules/auth/auth.service.js");
  const { env } = await import("../src/config/env.js");
  assert.equal(env.mobileAuthMode, "DEVELOPMENT");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); await rm(uploadRoot, { recursive: true }); });
  const origin = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function request(route, token, body, key, method) {
    const headers = {};
    if (token) headers.Authorization = "Bearer " + token;
    if (key) headers["Idempotency-Key"] = key;
    if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
    const response = await fetch(origin + route, { method: method ?? (body ? "POST" : "GET"), headers,
      body: body instanceof FormData ? body : JSON.stringify(body) });
    const payload = await response.json();
    return { status: response.status, data: payload.data, error: payload.error };
  }
  async function ok(...args) {
    const result = await request(...args);
    assert.ok(result.status < 300, `${args[0]}: ${JSON.stringify(result.error)}`);
    return result.data;
  }
  const suffix = randomUUID().slice(0, 8);
  const { barangayId } = await prisma.barangay.create({ data: { barangayName: "Fixture " + suffix, city: "Cebu", province: "Cebu" } });
  async function staff(role) {
    const user = await prisma.user.create({ data: { role, username: role === "DSWD_STAFF" ? null : role.toLowerCase() + suffix, employeeId: role + suffix,
      fullName: "Test reviewer", email: role + suffix + "@example.invalid", passwordHash: "fixture-only", barangayId } });
    return { id: user.userId, token: (await issueAccessToken(user, { ipAddress: "127.0.0.1" })).accessToken };
  }
  const admin = await staff("SYSTEM_ADMIN"), dswd = await staff("DSWD_STAFF");
  const person = { barangayId, firstName: "Maria", lastName: "Sample", address: "Sample address", birthDate: "1990-01-12" };
  const { beneficiaryId } = await prisma.beneficiary.create({ data: { ...person, birthDate: new Date(person.birthDate), sex: "FEMALE" } });
  const before = await prisma.beneficiary.count();
  const program = await prisma.program.create({ data: { programName: "Test " + suffix, programCode: suffix, programType: "CASH_ASSISTANCE",
    grantAmount: 1000, budgetAmount: 10000, status: "ACTIVE", createdById: admin.id } });
  const { enrollmentId } = await prisma.enrollment.create({ data: { beneficiaryId, programId: program.programId, submittedById: admin.id, reviewedById: dswd.id, reviewedAt: new Date(), status: "APPROVED" } });
  async function assignment(offset, deliveryMode) {
    const date = new Date(Date.now() + offset * 86400000);
    const event = await prisma.distribution.create({ data: { programId: program.programId, createdById: admin.id, title: "Test event", distributionDate: date,
      startTime: new Date("1970-01-01T08:00Z"), endTime: new Date("1970-01-01T09:00Z"), slotDurationMinutes: 60, location: "Test hall", barangayId,
      status: "OPEN", deliveryMode, ...(deliveryMode === "PHYSICAL_GOODS" ? { packageName: "Test pack", packageUnit: "pack", packageQuantity: 1 } : {}) } });
    const { distributionId } = event;
    const slot = await prisma.distributionSlot.create({ data: { distributionId, sessionId: randomUUID(), sessionLabel: "Fixture", location: "Test hall",
      slotStart: date, slotEnd: new Date(+date + 3600000), capacity: 1, slotStatus: "FULL" } });
    await prisma.distributionAllocation.create({ data: { distributionId, enrollmentId, beneficiaryId, amount: 1000, allocationStatus: "ALLOCATED", allocatedById: admin.id, allocatedAt: new Date() } });
    await prisma.schedule.create({ data: { distributionId, beneficiaryId, slotId: slot.slotId, queueNumber: 1 } });
    return distributionId;
  }
  const cash = await assignment(0, "SIMULATED_WALLET");
  const base = "/mobile/beneficiaries/me";
  const contactNumber = "+639" + String(randomInt(1e8, 1e9));
  const registration = await ok("/mobile/auth/register", null, { ...person, contactNumber, sex: "female" });
  assert.equal(registration.beneficiary.isVerified, false);
  const { accessToken } = await ok("/mobile/auth/otp/verify", null, { contactNumber, code: registration.developmentOtp, purpose: "register" });
  assert.equal((await ok(base, accessToken)).linkStatus, "PENDING");
  assert.equal((await request(base + "/wallet", accessToken)).status, 409);
  const login = await prisma.beneficiaryMobileAccount.findUniqueOrThrow({ where: { contactNumber } });
  const review = "/mobile-account-requests/" + login.linkId;
  await ok(review + "/decision", admin.token, { decision: "LINK", revision: 1, beneficiaryId, confirmedIdentity: true, note: "Fixture identity compared." });
  assert.equal(await prisma.beneficiary.count(), before);
  assert.equal((await ok(base, accessToken)).id, beneficiaryId);
  assert.equal((await ok(base + "/overview", accessToken)).nextSchedule.distributionId, cash);
  assert.equal((await request(base + "/claim-pass", accessToken, {})).status, 403);

  const bytes = Buffer.alloc(1024, 1);
  bytes.set([0xff, 0xd8, 0xff]);
  const image = new Blob([bytes], { type: "image/jpeg" });
  const document = new FormData();
  document.append("documentType", "VALID_ID"); document.append("file", image, "fixture-id.jpg");
  const { id: documentId } = await ok(base + "/documents", accessToken, document);
  const { policy } = await ok(base + "/biometrics", accessToken);
  const { consent } = await ok(base + "/biometric-consents", accessToken, { consentVersion: policy.version, retentionUntil: policy.retentionUntil, expectedConsentId: null });
  function selfie() {
    const form = new FormData();
    form.append("documentId", documentId); form.append("consentId", consent.id); form.append("consentVersion", "id-selfie-v1");
    form.append("faceCapture", image, "fixture-selfie.jpg"); return form;
  }
  env.biometricProcessorMode = "SIMULATED";
  assert.equal((await ok(base + "/identity", accessToken, selfie())).identityStatus, "CORRECTION");
  let matches = false;
  const transport = globalThis.fetch;
  env.biometricProcessorMode = "REMOTE"; env.biometricServiceUrl = "https://fixture.invalid";
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url !== "https://fixture.invalid/represent") return transport(url, options);
    const live = options.body.get("anti_spoofing") === "true";
    const embedding = Array(128).fill(0); embedding[live && !matches ? 1 : 0] = 1;
    return Response.json({ results: [{ embedding }] });
  });
  assert.equal((await ok(base + "/identity", accessToken, selfie())).identityStatus, "CORRECTION");
  matches = true;
  assert.equal((await ok(base + "/identity", accessToken, selfie())).identityStatus, "MATCHED");
  assert.equal((await ok(base, accessToken)).isVerified, false);
  const { revision } = await prisma.mobileBeneficiaryAccount.findUniqueOrThrow({ where: { accountId: login.linkId } });
  const approval = { decision: "APPROVE", revision, note: "Reviewed the matching fixture ID." };
  assert.equal((await request(review + "/identity", dswd.token, approval)).status, 403);
  assert.equal((await request(review + "/identity", admin.token, approval)).status, 409);
  await ok(`/beneficiaries/${beneficiaryId}/documents/${documentId}/review`, admin.token, { decision: "ACCEPTED" });
  await ok(review + "/identity", admin.token, approval);
  assert.equal((await ok(base, accessToken)).isVerified, true);
  const pass = await ok(base + "/claim-pass", accessToken, {});
  const claimPath = id => "/distributions/" + id + "/claims/";
  const scanned = { token: pass.claimCode };
  const preview = await ok(claimPath(cash) + "preview-qr", dswd.token, scanned);
  assert.equal(Number(preview.amount), 1000);
  assert.equal((await ok(base + "/wallet", accessToken)).transactions.length, 0);
  const keys = [randomUUID(), randomUUID()];
  const attempts = await Promise.all(keys.map(k => request(claimPath(cash) + "verify-qr", dswd.token, scanned, k)));
  const accepted = attempts.find(result => result.status === 201);
  assert.ok(accepted, JSON.stringify(attempts.map(a => a.error)));
  assert.equal(accepted.data.walletTransactionCreated, true);
  const winningKey = keys[attempts.indexOf(accepted)];
  assert.equal((await ok(claimPath(cash) + "verify-qr", dswd.token, scanned, winningKey)).ledgerReference, accepted.data.ledgerReference);
  assert.equal((await request(claimPath(cash) + "preview-qr", dswd.token, scanned)).status, 409);
  const wallet = await ok(base + "/wallet", accessToken);
  assert.equal(wallet.wallet.balance, 1000);
  assert.equal(wallet.transactions.length, 1);
  assert.equal(wallet.transactions[0].reference, accepted.data.ledgerReference);
  const goods = await assignment(1, "PHYSICAL_GOODS");
  const goodsPass = await ok(base + "/claim-pass", accessToken, {});
  const goodsScan = { token: goodsPass.claimCode };
  const goodsClaim = await ok(claimPath(goods) + "verify-qr", dswd.token, goodsScan, randomUUID());
  assert.equal(goodsClaim.walletTransactionCreated, false);
  const facilitator = await staff("BARANGAY_FACILITATOR");
  const goodsPath = claimPath(goods) + goodsClaim.claim.claimId;
  await ok(goodsPath + "/release", facilitator.token, { evidenceType: "OFFICIAL_RELEASE_LOG", evidenceReference: "QA handover",
    beneficiaryAcknowledged: true, releasedQuantity: 1 }, randomUUID());
  await ok(goodsPath + "/receipt", facilitator.token, {});
  const goodsRecord = (await ok(base + "/wallet", accessToken)).claims.find(claim => claim.id === goodsClaim.claim.claimId);
  assert.equal(goodsRecord.package.quantity, 1);
  assert.ok(goodsRecord.receipt.number);
  assert.equal(await prisma.transaction.count({ where: { distributionId: goods } }), 0);
  const expired = await assignment(2, "SIMULATED_WALLET");
  const expiredPass = await ok(base + "/claim-pass", accessToken, {});
  await prisma.qrToken.update({ where: { qrTokenId: expiredPass.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await request(claimPath(expired) + "preview-qr", dswd.token, { token: expiredPass.claimCode })).status, 410);
});
