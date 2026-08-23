import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import app from "../src/app.js";

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("health endpoint remains available", async () => {
  const response = await fetch(`${baseUrl}/api/v1/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
});

test("beneficiary endpoints require a staff access token", async () => {
  const [listResponse, createResponse] = await Promise.all([
    fetch(`${baseUrl}/api/v1/beneficiaries`),
    fetch(`${baseUrl}/api/v1/beneficiaries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  ]);

  assert.equal(listResponse.status, 401);
  assert.equal(createResponse.status, 401);

  for (const response of [listResponse, createResponse]) {
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "AUTHENTICATION_REQUIRED");
  }
});

test("program, enrollment, and document workflows require staff authentication", async () => {
  const beneficiaryId = "11111111-1111-4111-8111-111111111111";
  const programId = "22222222-2222-4222-8222-222222222222";
  const enrollmentId = "33333333-3333-4333-8333-333333333333";
  const responses = await Promise.all([
    fetch(`${baseUrl}/api/v1/programs`),
    fetch(`${baseUrl}/api/v1/programs/${programId}/enrollments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ beneficiaryId }),
    }),
    fetch(`${baseUrl}/api/v1/enrollments/${enrollmentId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    fetch(`${baseUrl}/api/v1/beneficiaries/${beneficiaryId}/documents`),
  ]);

  for (const response of responses) {
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "AUTHENTICATION_REQUIRED");
  }
});

test("audit-log list and detail endpoints require staff authentication", async () => {
  const auditId = "44444444-4444-4444-8444-444444444444";
  const responses = await Promise.all([
    fetch(`${baseUrl}/api/v1/audit-logs`),
    fetch(`${baseUrl}/api/v1/audit-logs/${auditId}`),
  ]);

  for (const response of responses) {
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "AUTHENTICATION_REQUIRED");
  }
});

test("distribution, QR, claim, and simulated-wallet endpoints require staff authentication", async () => {
  const distributionId = "55555555-5555-4555-8555-555555555555";
  const allocationId = "66666666-6666-4666-8666-666666666666";
  const qrTokenId = "77777777-7777-4777-8777-777777777777";
  const claimId = "88888888-8888-4888-8888-888888888888";
  const walletId = "99999999-9999-4999-8999-999999999999";
  const transactionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const responses = await Promise.all([
    fetch(`${baseUrl}/api/v1/distributions`),
    fetch(`${baseUrl}/api/v1/distributions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}`),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/slots`),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/eligible-enrollments`),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/allocations`),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/allocations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": allocationId,
      },
      body: JSON.stringify({ enrollmentIds: [allocationId] }),
    }),
    fetch(
      `${baseUrl}/api/v1/distributions/${distributionId}/allocations/${allocationId}`,
    ),
    fetch(
      `${baseUrl}/api/v1/distributions/${distributionId}/allocations/${allocationId}/cancel`,
      { method: "POST" },
    ),
    fetch(
      `${baseUrl}/api/v1/distributions/${distributionId}/allocations/${allocationId}/reactivate`,
      { method: "POST" },
    ),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/qr-eligible-schedules`),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/qr-tokens`),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/qr-tokens/${qrTokenId}`),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/claims`),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/claims/${claimId}`),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/creditable-claims`),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/transactions`),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/reconciliation`),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/claims/${claimId}/credit`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": claimId },
      body: JSON.stringify({}),
    }),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/qr-scan-logs`),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/claims/verify-qr`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": claimId,
      },
      body: JSON.stringify({ token: "unknown" }),
    }),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/claims/verify-biometric`, {
      method: "POST",
    }),
    fetch(`${baseUrl}/api/v1/distributions/${distributionId}/biometric-attempts`),
    fetch(`${baseUrl}/api/v1/beneficiaries/${claimId}/biometric-consents`),
    fetch(`${baseUrl}/api/v1/beneficiaries/${claimId}/biometrics/status`),
    fetch(`${baseUrl}/api/v1/beneficiaries/${claimId}/biometrics`, { method: "DELETE" }),
    fetch(`${baseUrl}/api/v1/wallets/${walletId}`),
    fetch(`${baseUrl}/api/v1/wallets/${walletId}/transactions`),
    fetch(`${baseUrl}/api/v1/wallets/${walletId}/transactions/${transactionId}/receipt`),
  ]);

  for (const response of responses) {
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "AUTHENTICATION_REQUIRED");
  }
});
