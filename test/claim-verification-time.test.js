import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.BIOMETRIC_PROCESSOR_MODE = 'SIMULATED';
process.env.FIELD_ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
const db = {};
globalThis.prisma = db;
const { verifyQrClaim } = await import('../src/modules/distributions/distributionClaim.controller.js');
const { verifyBiometricClaim, submitClaimSignature } = await import('../src/modules/biometrics/biometricClaim.controller.js');
const { processBiometricEnrollment, encryptBiometricTemplate } = await import('../src/modules/biometrics/biometric.service.js');
const { claimIdentityRequirementSatisfied, assertPhysicalClaimReleasable, qrClaimPreviewOutcome } = await import('../src/modules/distributions/distributionClaim.service.js');
const { assertClaimCreditable } = await import('../src/modules/wallets/wallet.service.js');

function capture() {
  return { mimetype: 'image/png', buffer: Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ...Array.from({ length: 40 }, (_, i) => createHash('sha512').update(`time-fixture:${i}`).digest()),
  ]) };
}
const beneficiaryId = randomUUID(), distributionId = randomUUID(), consentId = randomUUID();
const staffId = randomUUID();
const embedding = (await processBiometricEnrollment(capture())).embedding;
const profile = {
  biometricId: randomUUID(), beneficiaryId, consentId, dataStatus: 'ACTIVE',
  consent: { consentGiven: true, retentionUntil: new Date('2100-01-01') },
  faceEmbedding: encryptBiometricTemplate(embedding, beneficiaryId, consentId),
};

function fixture(requirement, existing = null) {
  let claim = existing && { claimId: randomUUID(), beneficiaryId, distributionId, beneficiary: { firstName: 'Maria', lastName: 'Santos' }, ...existing };
  let recordedRequest;
  const token = { qrTokenId: randomUUID(), beneficiaryId, distributionId, qrStatus: 'ACTIVE', expiresAt: new Date('2100-01-01') };
  const schedule = { scheduleId: randomUUID(), status: existing ? 'CHECKED_IN' : 'SCHEDULED' };
  const writeClaim = async ({ data }) => (claim = { claimId: randomUUID(), ...claim, ...data });
  Object.assign(db, {
    $transaction: async (fn) => fn(db),
    distribution: { findFirst: async () => ({ distributionId, status: 'OPEN', verificationRequirement: requirement, deliveryMode: 'PHYSICAL_GOODS' }) },
    schedule: { findUnique: async () => schedule, updateMany: async () => { schedule.status = 'CHECKED_IN'; return { count: 1 }; } },
    distributionAllocation: { findUnique: async () => ({ allocationId: randomUUID(), allocationStatus: 'ALLOCATED' }) },
    claim: { findUnique: async () => claim, create: writeClaim, update: writeClaim },
    qrToken: { findFirst: async () => token, updateMany: async () => { token.qrStatus = 'USED'; return { count: 1 }; } },
    qrScanLog: { create: async () => ({ scanLogId: randomUUID() }) },
    biometricData: { findUnique: async () => profile, update: async () => ({}) },
    biometricVerificationAttempt: { create: async () => ({ attemptId: randomUUID() }) },
    claimSignature: { create: async ({ data }) => ({ ...data, signatureId: randomUUID(), signedAt: new Date() }) },
    auditLog: { create: async () => ({}) },
    idempotencyRecord: { deleteMany: async () => ({}), findUnique: async ({ where }) => {
      const identity = where.userId_operation_idempotencyKey;
      return recordedRequest && ['userId', 'operation', 'idempotencyKey'].every(key => recordedRequest[key] === identity[key]) ? recordedRequest : null;
    }, create: async ({ data }) => { recordedRequest = data; return data; } },
  });
  return { claim: () => claim, newRequest: () => { recordedRequest = null; } };
}

function invoke(handler, extra = {}, key = randomUUID()) {
  return new Promise((resolve, reject) => handler({
    staffUser: { role: 'DSWD_STAFF' }, auth: { userId: staffId }, headers: {}, socket: {},
    get: () => key, validatedParams: { distributionId }, validatedBody: { beneficiaryId, token: 'fixture-token' },
    ...extra,
  }, { set() {}, once() {}, status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, body }); } }, reject));
}

test('either allowed method completes an alternative-method claim, with no second claim through the other method', async () => {
  for (const first of ['QR', 'BIOMETRIC']) {
    const state = fixture('QR_OR_BIOMETRIC');
    const face = () => invoke(verifyBiometricClaim, { file: capture() });
    const result = await (first === 'QR' ? invoke(verifyQrClaim) : face());
    assert.equal(result.status, 201);
    assert.equal(result.body.data.verificationComplete, true);
    assert.equal(result.body.data.nextRequiredVerification, null);
    assert.equal(state.claim().claimStatus, 'VERIFIED');
    assert.equal(state.claim().verificationMethod, 'QR_OR_BIOMETRIC');
    assert.equal(state.claim().qrVerified, first === 'QR');
    assert.equal(state.claim().biometricVerified, first === 'BIOMETRIC');
    assert.equal(claimIdentityRequirementSatisfied(state.claim()), true);
    assert.ok(state.claim().verifiedAt instanceof Date);
    const claimId = state.claim().claimId;
    state.newRequest();
    assert.equal((await (first === 'QR' ? face() : invoke(verifyQrClaim))).status, 409);
    assert.equal(state.claim().claimId, claimId);
  }
});

test('a missing face profile leaves the claim unverified and an allowed QR can still be used', async () => {
  const state = fixture('QR_OR_BIOMETRIC');
  db.biometricData.findUnique = async () => null;
  const face = await invoke(verifyBiometricClaim, { file: capture() });
  assert.equal(face.status, 409);
  assert.equal(state.claim(), null);
  state.newRequest();
  assert.equal((await invoke(verifyQrClaim)).status, 201);
  assert.equal(state.claim().claimStatus, 'VERIFIED');
});

test('alternative identity gate and both settlement paths require at least one successful check', () => {
  const base = { claimStatus: 'VERIFIED', verificationMethod: 'QR_OR_BIOMETRIC',
    allocation: { allocationStatus: 'ALLOCATED' }, schedule: { status: 'CHECKED_IN' }, beneficiary: { status: 'ACTIVE' } };
  for (const qrVerified of [false, true]) for (const biometricVerified of [false, true]) {
    const claim = { ...base, qrVerified, biometricVerified };
    assert.equal(Boolean(claimIdentityRequirementSatisfied(claim)), qrVerified || biometricVerified);
    const physical = () => assertPhysicalClaimReleasable(claim, { status: 'OPEN', deliveryMode: 'PHYSICAL_GOODS' });
    const wallet = () => assertClaimCreditable({ ...claim, distribution: { deliveryMode: 'SIMULATED_WALLET' } });
    if (qrVerified || biometricVerified) { assert.doesNotThrow(physical); assert.doesNotThrow(wallet); }
    else { assert.throws(physical, { code: 'CLAIM_IDENTITY_NOT_VERIFIED' }); assert.throws(wallet, { code: 'CLAIM_IDENTITY_NOT_VERIFIED' }); }
  }
  assert.equal(claimIdentityRequirementSatisfied({ ...base, verificationMethod: 'QR_AND_BIOMETRIC', qrVerified: true, biometricVerified: false }), false);
  const preview = qrClaimPreviewOutcome({ distribution: { verificationRequirement: 'QR_OR_BIOMETRIC' },
    qrToken: { qrStatus: 'ACTIVE', expiresAt: new Date('2100-01-01') }, schedule: { status: 'SCHEDULED' }, allocation: { allocationStatus: 'ALLOCATED' } });
  assert.equal(preview.verificationCompleteAfterConfirm, true);
  assert.equal(preview.nextRequiredVerification, null);
});

test('QR-only completion records a stable time across replay and a later duplicate scan', async () => {
  const state = fixture('QR');
  const key = randomUUID();
  const before = Date.now();
  const result = await invoke(verifyQrClaim, {}, key);
  assert.equal(result.status, 201);
  assert.ok(state.claim().verifiedAt instanceof Date);
  assert.ok(state.claim().verifiedAt.getTime() >= before);
  const verifiedAt = state.claim().verifiedAt.toISOString();
  const replay = await invoke(verifyQrClaim, {}, key);
  assert.equal(replay.body.data.claim.verifiedAt, verifiedAt);
  state.newRequest();
  assert.equal((await invoke(verifyQrClaim)).status, 409);
  assert.equal(state.claim().verifiedAt.toISOString(), verifiedAt);
});

test('combined QR and face verification records time only when the second check completes, in either order', async () => {
  for (const first of ['QR', 'BIOMETRIC']) {
    const state = fixture('QR_AND_BIOMETRIC');
    const face = () => invoke(verifyBiometricClaim, { file: capture() });
    assert.equal((await (first === 'QR' ? invoke(verifyQrClaim) : face())).status, 201);
    assert.equal(state.claim().claimStatus, 'PENDING');
    assert.equal(state.claim().verifiedAt, null);
    state.newRequest();
    const before = Date.now();
    assert.equal((await (first === 'QR' ? face() : invoke(verifyQrClaim))).status, 201);
    assert.equal(state.claim().claimStatus, 'VERIFIED');
    assert.ok(state.claim().verifiedAt.getTime() >= before);
  }
});

test('face-only records completion, while face plus signature waits for the signature', async () => {
  let state = fixture('BIOMETRIC');
  assert.equal((await invoke(verifyBiometricClaim, { file: capture() })).status, 201);
  assert.ok(state.claim().verifiedAt instanceof Date);
  state = fixture('BIOMETRIC_AND_SIGNATURE');
  assert.equal((await invoke(verifyBiometricClaim, { file: capture() })).status, 201);
  assert.equal(state.claim().verifiedAt, null);
  state.newRequest();
  const claimId = state.claim().claimId;
  const result = await invoke(submitClaimSignature, {
    validatedParams: { distributionId, claimId },
    validatedBody: { signatureMethod: 'DRAWN', pointCount: 20, signatureDataUrl: `data:image/png;base64,${capture().buffer.toString('base64')}` },
  });
  assert.equal(result.status, 201);
  assert.equal(state.claim().claimStatus, 'VERIFIED');
  assert.equal(state.claim().verifiedAt.toISOString(), result.body.data.signature.signedAt);
});
