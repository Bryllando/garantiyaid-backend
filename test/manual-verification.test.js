import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
process.env.FIELD_ENCRYPTION_KEY = 'ab'.repeat(32);
const db = {};
globalThis.prisma = db;
const { manualVerificationSchema, verifyManualClaim } = await import('../src/modules/distributions/distributionManualVerification.controller.js');
const { submitClaimSignature } = await import('../src/modules/biometrics/biometricClaim.controller.js');
const { manualVerificationAllowed } = await import('../src/modules/distributions/manualVerification.service.js');
const { claimIdentityRequirementSatisfied, assertPhysicalClaimReleasable } = await import('../src/modules/distributions/distributionClaim.service.js');
const distributionId = randomUUID(), beneficiaryId = randomUUID(), staffId = randomUUID(), barangayId = randomUUID();
const basis = 'TEST ONLY — reviewer checks the consenting demo participant against the synthetic appointment; no government policy.';
const invoke = (handler, body, role = 'BARANGAY_FACILITATOR', key = randomUUID()) => new Promise((resolve, reject) => handler({
  validatedParams: { distributionId, claimId: 'saved-claim' }, validatedBody: body,
  staffUser: { userId: staffId, fullName: 'Demo Facilitator', role, barangayId }, auth: { userId: staffId },
  get: () => key,
}, { once() {}, set() {}, status(status) { this.code = status; return this; }, json(body) { resolve({ status: this.code, body }); } }, reject));
const evidence = { beneficiaryId, evidenceReference: 'DEMO-ID-01 / row 1', notes: 'Reviewed the consenting participant and the demo appointment in person.', confirmed: true };
let claim, event, profileStatus, enrollmentStatus, scheduleStatus, receipts, records, releaseWrites;
function fixture() {
  claim = null; profileStatus = 'ACTIVE'; enrollmentStatus = 'APPROVED'; scheduleStatus = 'SCHEDULED'; records = new Map(); receipts = 0; releaseWrites = 0;
  event = { distributionId, status: 'OPEN', barangayId, verificationRequirement: 'QR_OR_BIOMETRIC', manualVerificationBasis: basis };
  Object.assign(db, {
    distribution: { findFirst: async ({ where }) => where.barangayId && where.barangayId !== barangayId ? null : event },
    schedule: { findUnique: async () => ({ scheduleId: 'schedule', status: scheduleStatus, beneficiary: { status: 'ACTIVE', barangayId }, slot: { slotEnd: new Date(Date.now() + 3600000) } }), updateMany: async () => { scheduleStatus = 'CHECKED_IN'; return { count: 1 }; } },
    distributionAllocation: { findUnique: async () => ({ allocationId: 'allocation', allocationStatus: 'ALLOCATED', enrollment: { status: enrollmentStatus } }) },
    biometricData: { findUnique: async () => ({ dataStatus: profileStatus }) },
    claim: { findUnique: async () => claim, create: async ({ data }) => (claim = { ...data, claimId: 'saved-claim', beneficiary: { firstName: 'Demo', lastName: 'Participant' } }), update: async ({ data }) => (claim = { ...claim, ...data }) },
    idempotencyRecord: { findUnique: async ({ where }) => records.get(JSON.stringify(where.userId_operation_idempotencyKey)) || null, deleteMany: async () => ({}), create: async ({ data }) => { records.set(JSON.stringify({ userId: data.userId, operation: data.operation, idempotencyKey: data.idempotencyKey }), data); return data; } },
    claimSignature: { create: async ({ data }) => ({ ...data, signatureId: randomUUID(), signedAt: new Date() }) },
    auditLog: { create: async () => ({}) },
    $transaction: async (work) => work(db),
  });
}

test('manual option is opt-in and never weakens combined event rules', () => {
  for (const requirement of ['QR', 'BIOMETRIC', 'QR_OR_BIOMETRIC', 'MANUAL']) assert.equal(manualVerificationAllowed({ verificationRequirement: requirement, manualVerificationBasis: basis }), true);
  for (const requirement of ['QR_AND_BIOMETRIC', 'BIOMETRIC_AND_SIGNATURE']) assert.equal(manualVerificationAllowed({ verificationRequirement: requirement, manualVerificationBasis: basis }), false);
  assert.equal(manualVerificationAllowed({ verificationRequirement: 'QR' }), false);
  for (const invalid of [{ ...evidence, confirmed: false }, { ...evidence, notes: '' }, { ...evidence, evidenceReference: '' }, { ...evidence, manualVerification: {} }]) assert.equal(manualVerificationSchema.safeParse(invalid).success, false);
  assert.equal(claimIdentityRequirementSatisfied({ verificationMethod: 'MANUAL', signatureVerified: true }), false);
});

test('manual review requires authorized scope, approved allocation and resolved identity holds', async () => {
  fixture(); await assert.rejects(invoke(verifyManualClaim, evidence, 'SYSTEM_ADMIN'), { code: 'FORBIDDEN' });
  fixture(); event.barangayId = 'different'; db.distribution.findFirst = async () => null; await assert.rejects(invoke(verifyManualClaim, evidence), { code: 'DISTRIBUTION_NOT_FOUND' });
  fixture(); event.manualVerificationBasis = null; await assert.rejects(invoke(verifyManualClaim, evidence), { code: 'MANUAL_VERIFICATION_NOT_ALLOWED' });
  fixture(); event.verificationRequirement = 'QR_AND_BIOMETRIC'; await assert.rejects(invoke(verifyManualClaim, evidence), { code: 'MANUAL_VERIFICATION_NOT_ALLOWED' });
  fixture(); profileStatus = 'DUPLICATE_BLOCKED'; await assert.rejects(invoke(verifyManualClaim, evidence), { code: 'BIOMETRIC_DUPLICATE_REVIEW_REQUIRED' });
  fixture(); enrollmentStatus = 'SUSPENDED'; await assert.rejects(invoke(verifyManualClaim, evidence), { code: 'MANUAL_CLAIM_NOT_READY' });
  fixture(); scheduleStatus = 'CANCELLED'; await assert.rejects(invoke(verifyManualClaim, evidence), { code: 'MANUAL_CLAIM_NOT_READY' });
});

test('manual review waits for acknowledgment; replay and duplicate attempts cannot release assistance', async () => {
  fixture(); const key = randomUUID();
  const first = await invoke(verifyManualClaim, evidence, undefined, key);
  assert.equal(first.status, 201); assert.equal(first.body.data.verificationComplete, false);
  assert.equal(claim.claimStatus, 'PENDING'); assert.equal(scheduleStatus, 'CHECKED_IN');
  assert.equal(claimIdentityRequirementSatisfied(claim), false);
  const replay = await invoke(verifyManualClaim, evidence, undefined, key);
  assert.deepEqual(replay.body, first.body);
  await assert.rejects(invoke(verifyManualClaim, { ...evidence, notes: 'Changed notes are not the same review request.' }, undefined, key), { code: 'IDEMPOTENCY_KEY_REUSED' });
  await assert.rejects(invoke(verifyManualClaim, evidence), { code: 'DUPLICATE_CLAIM' });
  const signature = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(256, 35)]);
  await invoke(submitClaimSignature, { signatureDataUrl: `data:image/png;base64,${signature.toString('base64')}`, signatureMethod: 'TYPED', typedName: 'Demo Participant', attestation: true });
  assert.equal(claim.claimStatus, 'VERIFIED'); assert.equal(claim.signatureVerified, true);
  assert.equal(claimIdentityRequirementSatisfied(claim), true);
  assert.equal(claim.releasedAt, undefined); assert.equal(receipts, 0); assert.equal(releaseWrites, 0);
});

test('a signature cannot invent a manual review or bypass required face verification', async () => {
  fixture(); claim = { claimId: 'saved-claim', distributionId, beneficiaryId, claimStatus: 'PENDING', verificationMethod: 'MANUAL', beneficiary: { firstName: 'Demo', lastName: 'Participant' } };
  const body = { signatureDataUrl: `data:image/png;base64,${Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(256)]).toString('base64')}`, signatureMethod: 'TYPED', typedName: 'Demo Participant' };
  await assert.rejects(invoke(submitClaimSignature, body), { code: 'CLAIM_NOT_READY_FOR_SIGNATURE' });
  event.verificationRequirement = 'QR'; claim.biometricVerified = true; claim.verificationMethod = 'BIOMETRIC_AND_SIGNATURE';
  await assert.rejects(invoke(submitClaimSignature, body), { code: 'SIGNATURE_REQUIREMENT_CHANGED' });
  claim.biometricVerified = false;
  event.verificationRequirement = 'BIOMETRIC_AND_SIGNATURE'; claim.verificationMethod = 'BIOMETRIC_AND_SIGNATURE';
  await assert.rejects(invoke(submitClaimSignature, body), { code: 'CLAIM_NOT_READY_FOR_SIGNATURE' });
  assert.throws(() => assertPhysicalClaimReleasable({ ...claim, claimStatus: 'VERIFIED', signatureVerified: true }, { status: 'OPEN', deliveryMode: 'PHYSICAL_GOODS' }), { code: 'CLAIM_IDENTITY_NOT_VERIFIED' });
});
