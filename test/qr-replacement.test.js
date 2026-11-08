import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

// Isolated controller fixture: no database connection or live credential mutation.
const prisma = { $transaction: async () => {}, qrToken: { findFirst: async () => {} } };
globalThis.prisma = prisma;
const { reissueQrToken } = await import('../src/modules/distributions/distributionClaim.controller.js');
const { hashQrToken } = await import('../src/modules/distributions/distributionClaim.service.js');
const distributionId = randomUUID(), qrTokenId = randomUUID(), beneficiaryId = randomUUID();
const req = role => ({ validatedParams: { distributionId, qrTokenId }, staffUser: { role, userId: 'test-admin' }, auth: { userId: 'test-admin' }, ip: '127.0.0.1', get: () => undefined });
const invoke = role => new Promise((resolve, reject) => reissueQrToken(req(role), { status(code) { assert.equal(code, 200); return this; }, json: resolve }, reject));

function fixture(t, options = {}) {
  let writes = 0, audits = [];
  const originalHash = hashQrToken('synthetic-original-not-a-live-token');
  const record = { distributionId, qrTokenId, beneficiaryId, qrStatus: options.qrStatus ?? 'ACTIVE', tokenHash: originalHash, expiresAt: new Date(options.expired ? '2000-01-01' : '2099-11-11'), beneficiary: { firstName: 'Synthetic', lastName: 'Recipient', status: 'ACTIVE' } };
  const find = async args => {
    assert.equal(args.where.distributionId, distributionId);
    if (args.select.tokenHash) return { ...record };
    const { tokenHash: _privateHash, ...publicRecord } = record;
    return publicRecord;
  };
  const tx = {
    distribution: { findFirst: async () => ({ distributionId, status: options.eventStatus ?? 'OPEN', verificationRequirement: 'QR', distributionDate: new Date('2099-11-11'), endTime: '12:00' }) },
    qrToken: { findFirst: find, updateMany: async args => {
      assert.equal(args.where.tokenHash, originalHash, 'Replacement must compare the original hash as well as status');
      if (options.concurrent) return { count: 0 };
      Object.assign(record, args.data); writes++;
      return { count: 1 };
    } },
    schedule: { findUnique: async () => ({ status: options.scheduleStatus ?? 'SCHEDULED', slot: { slotEnd: new Date(options.ended ? '2000-01-01' : '2099-11-11T04:00:00Z') } }) },
    distributionAllocation: { findUnique: async () => ({ allocationStatus: options.allocationStatus ?? 'ALLOCATED' }) },
    claim: { findUnique: async () => options.hasClaim ? { claimId: 'existing-claim' } : null },
    auditLog: { create: async args => { audits.push(args.data); } },
  };
  t.mock.method(prisma, '$transaction', async (operation, config) => {
    assert.equal(config.isolationLevel, 'Serializable');
    return operation(tx);
  });
  t.mock.method(prisma.qrToken, 'findFirst', find);
  return { record, originalHash, writes: () => writes, audits: () => audits };
}

for (const options of [{ qrStatus: 'ACTIVE' }, { qrStatus: 'REVOKED' }, { qrStatus: 'ACTIVE', expired: true }]) {
  test(`eligible ${options.qrStatus}${options.expired ? ' expired' : ''} QR replacement returns the new value once without exposing its hash`, async t => {
    const state = fixture(t, options);
    const result = await invoke('SYSTEM_ADMIN');
    assert.equal(result.data.rawTokenReturnedOnce, true);
    assert.equal(state.writes(), 1);
    assert.equal(state.record.tokenHash, hashQrToken(result.data.qrToken.token));
    assert.notEqual(state.record.tokenHash, state.originalHash, 'The old card no longer matches the stored credential');
    assert.equal(Object.hasOwn(result.data.qrToken, 'tokenHash'), false);
    assert.equal(state.audits()[0].action, 'QR_TOKEN_REISSUED');
    assert.equal(JSON.stringify(state.audits()).includes(result.data.qrToken.token), false);
  });
}
for (const options of [{ qrStatus: 'USED' }, { ended: true }, { hasClaim: true }, { scheduleStatus: 'CHECKED_IN' }, { allocationStatus: 'CANCELLED' }, { eventStatus: 'CLOSED' }, { concurrent: true }]) {
  test(`QR replacement preserves claim/schedule/concurrency guards: ${JSON.stringify(options)}`, async t => {
    const state = fixture(t, options);
    await assert.rejects(invoke('SYSTEM_ADMIN'), error => error.statusCode === 409);
    assert.equal(state.writes(), 0);
    assert.equal(state.audits().length, 0);
  });
}
test('Barangay and DSWD staff cannot replace QR credentials', async t => {
  const state = fixture(t);
  for (const role of ['BARANGAY_FACILITATOR', 'DSWD_STAFF']) await assert.rejects(invoke(role), error => error.statusCode === 403);
  assert.equal(state.writes(), 0);
});
