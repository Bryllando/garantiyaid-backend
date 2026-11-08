import test from 'node:test';
import assert from 'node:assert/strict';

const duplicate = Object.assign(new Error('Concurrent receipt insert'), { code: 'P2002' });
const saved = {
  receiptId: 'original-receipt', receiptNo: 'original-number',
  issuedBy: { userId: 'first-issuer' }, evidenceHash: 'original-hash',
  snapshot: { evidence: 'original evidence' }, claim: { claimStatus: 'CLAIMED', distributionId: 'event-1' },
};
const database = {
  distribution: { findFirst: async () => ({ distributionId: 'event-1' }) },
  $transaction: async () => { throw duplicate; },
  claimReceipt: { findFirst: async () => saved },
};
globalThis.prisma = database;
const { issueClaimReceipt } = await import('../src/modules/distributions/distributionClaimAccountability.controller.js');
const invoke = () => new Promise((resolve, reject) => issueClaimReceipt({
  staffUser: { role: 'SYSTEM_ADMIN' }, auth: { userId: 'second-issuer' },
  validatedParams: { distributionId: 'event-1', claimId: 'claim-1' },
}, { status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, body }); } }, reject));

test('a losing receipt insert returns the original receipt without changing its issuer or evidence', async t => {
  t.mock.method(database.claimReceipt, 'findFirst', async ({ where }) => {
    assert.deepEqual(where, { claimId: 'claim-1', claim: { distributionId: 'event-1' } });
    return saved;
  });
  const result = await invoke();
  assert.equal(result.status, 200);
  assert.equal(result.body.data.created, false);
  const { claim, ...original } = saved;
  assert.deepEqual(result.body.data.receipt, { ...original, currentClaimStatus: claim.claimStatus });
});

test('an unrelated unique conflict cannot return another claim receipt or pretend success', async t => {
  t.mock.method(database.claimReceipt, 'findFirst', async () => null);
  await assert.rejects(invoke(), error => error === duplicate);
});

test('receipt recovery does not hide other database failures or bypass event access', async t => {
  t.mock.method(database.claimReceipt, 'findFirst', async () => assert.fail('No recovery lookup is allowed.'));
  const unavailable = Object.assign(new Error('Database unavailable'), { code: 'P1001' });
  t.mock.method(database, '$transaction', async () => { throw unavailable; });
  await assert.rejects(invoke(), error => error === unavailable);
  t.mock.method(database.distribution, 'findFirst', async () => null);
  t.mock.method(database, '$transaction', async () => assert.fail('Unauthorized event must not reach a transaction.'));
  await assert.rejects(invoke(), error => error.code === 'DISTRIBUTION_NOT_FOUND');
});
