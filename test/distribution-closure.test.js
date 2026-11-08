import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
const db = {};
globalThis.prisma = db;
const { distributionReconciliation } = await import('../src/modules/distributions/distributionReconciliation.service.js');
const { closeDistribution } = await import('../src/modules/distributions/distribution.controller.js');
const { closeDistributionSchema } = await import('../src/modules/distributions/distribution.schemas.js');

function fixture(deliveryMode = 'PHYSICAL_GOODS') {
  const distribution = { distributionId: 'event-1', barangayId: 'area-1', updatedAt: new Date('2026-01-01'), status: 'OPEN', deliveryMode, distributionDate: new Date('2026-01-01'), startTime: new Date('1970-01-01T00:00:00Z'), endTime: new Date('1970-01-01T01:00:00Z') };
  const credit = { transactionType: 'BENEFIT_CREDIT', status: 'COMPLETED', amount: '1500.00', walletId: 'wallet-1' };
  const claim = { claimId: 'claim-1', claimStatus: 'CLAIMED', allocation: { allocationId: 'allocation-1', amount: '1500.00', allocationStatus: 'CLAIMED' }, releaseMethod: deliveryMode, releasedAt: new Date('2026-01-01'), releasedById: 'staff-1', receipt: { receiptId: 'receipt-1' }, disputes: [], isDuplicateFlag: false, transactions: deliveryMode === 'SIMULATED_WALLET' ? [credit] : [] };
  const schedules = [{ beneficiaryId: 'unvisited-1', status: 'SCHEDULED', slot: { slotEnd: new Date('2026-01-01') }, claim: null }];
  const writes = [], audits = [], transactions = [];
  Object.assign(db, {
    $transaction: async (run, options) => { transactions.push(options); return run(db); },
    distribution: { findFirst: async () => distribution, updateMany: async (args) => { writes.push(args); Object.assign(distribution, args.data); return { count: 1 }; } },
    distributionAllocation: { findMany: async () => [claim.allocation] },
    claim: { findMany: async () => [claim] },
    transaction: { findMany: async () => claim.transactions },
    walletAccount: { findMany: async () => [{ walletId: 'wallet-1', beneficiaryId: 'person-1', balance: '1500.00', transactions: [credit] }] },
    schedule: { findMany: async () => schedules, updateMany: async (args) => { writes.push(args); return { count: 1 }; } },
    distributionSlot: { updateMany: async (args) => { writes.push(args); return { count: 1 }; } },
    qrToken: { updateMany: async (args) => { writes.push(args); return { count: 1 }; } },
    auditLog: { create: async ({ data }) => { audits.push(data); return data; } },
  });
  return { distribution, claim, schedules, writes, audits, transactions };
}

function invoke(role = 'SYSTEM_ADMIN') {
  return new Promise((resolve, reject) => closeDistribution({ staffUser: { role }, auth: { userId: 'admin-1' }, validatedParams: { distributionId: 'event-1' }, validatedBody: { notes: 'Reviewed all handovers, receipts and attendance.' }, headers: {}, socket: {} }, {
    status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, body }); },
  }, reject));
}

test('closure reconciles physical and simulated branches, preserves evidence, and makes repeat requests harmless', async () => {
  for (const mode of ['PHYSICAL_GOODS', 'SIMULATED_WALLET']) {
    const state = fixture(mode);
    const before = structuredClone(state.claim);
    const review = await distributionReconciliation(state.distribution, db);
    assert.equal(review.readyToClose, true);
    assert.equal(review.unvisitedScheduleCount, 1);
    assert.equal(review.netCreditedAmount, mode === 'PHYSICAL_GOODS' ? '0.00' : '1500.00');
    const result = await invoke();
    assert.equal(result.status, 200);
    assert.equal(result.body.data.distribution.status, 'CLOSED');
    assert.deepEqual(state.claim, before);
    assert.deepEqual(state.transactions, [{ isolationLevel: 'Serializable' }]);
    assert.equal(state.audits.length, 1);
    assert.equal(state.audits[0].details.notes, 'Reviewed all handovers, receipts and attendance.');
    assert.equal(state.audits[0].details.missedScheduleCount, 1);
    assert.deepEqual(state.writes[1].where.claim, null);
    assert.equal(state.writes[1].where.status, 'SCHEDULED');
    assert.ok(state.writes[1].where.slot.slotEnd.lte instanceof Date);
    assert.equal(state.writes[3].where.qrStatus, 'ACTIVE');
    assert.equal(state.writes[3].data.qrStatus, 'REVOKED');
    await invoke();
    assert.equal(state.audits.length, 1);
    assert.equal(state.writes.length, 4);
  }
});

test('closure blocks incomplete verification, holds, missing receipts, release and ledger mismatches before writes', async () => {
  const cases = [
    ['CLAIM_VERIFICATION_INCOMPLETE', s => { s.claim.claimStatus = 'PENDING'; }],
    ['ACTIVE_CLAIM_DISPUTE', s => { s.claim.disputes = [{ disputeId: 'case-1' }]; }],
    ['FLAGGED_CLAIM', s => { s.claim.isDuplicateFlag = true; }],
    ['CLAIM_RECEIPT_MISSING', s => { s.claim.receipt = null; }],
    ['VERIFIED_PHYSICAL_CLAIM_AWAITING_RELEASE', s => { s.claim.claimStatus = 'VERIFIED'; }],
    ['CLAIMED_WITHOUT_PHYSICAL_RELEASE_EVIDENCE', s => { s.claim.releasedAt = null; }],
    ['VISIT_OUTCOME_REQUIRED', s => { s.schedules[0].slot.slotEnd = new Date('2100-01-01'); }],
    ['VISIT_OUTCOME_REQUIRED', s => { s.schedules[0].status = 'CHECKED_IN'; }],
    ['EVENT_CREDIT_TOTAL_MISMATCH', s => { s.claim.releaseMethod = 'SIMULATED_WALLET'; s.claim.transactions = [{ transactionType: 'BENEFIT_CREDIT', status: 'COMPLETED', amount: '1000', walletId: 'wallet-1' }]; db.walletAccount.findMany = async () => [{ balance: '1000', transactions: s.claim.transactions }]; }],
    ['WALLET_LEDGER_BALANCE_MISMATCH', s => { s.claim.releaseMethod = 'SIMULATED_WALLET'; s.claim.transactions = [{ transactionType: 'BENEFIT_CREDIT', status: 'COMPLETED', walletId: 'wallet-1', amount: '1500' }]; db.walletAccount.findMany = async () => [{ walletId: 'wallet-1', balance: '100', transactions: s.claim.transactions }]; }],
  ];
  for (const [code, change] of cases) {
    const state = fixture(); change(state);
    await assert.rejects(invoke(), error => error.code === 'DISTRIBUTION_NOT_RECONCILED' && error.details.reconciliation.exceptions.some(item => item.code === code));
    assert.equal(state.writes.length, 0, code);
    assert.equal(state.audits.length, 0, code);
    assert.equal(state.distribution.status, 'OPEN');
  }
});

test('only Admin can close an open event, conflicts remain retryable, and closure needs a note', async () => {
  for (const role of ['DSWD_STAFF', 'BARANGAY_FACILITATOR']) {
    const state = fixture();
    await assert.rejects(invoke(role), error => error.statusCode === 403);
    assert.equal(state.transactions.length, 0);
  }
  for (const status of ['DRAFT', 'CANCELLED']) {
    const state = fixture(); state.distribution.status = status;
    await assert.rejects(invoke(), error => error.code === 'INVALID_DISTRIBUTION_TRANSITION');
    assert.equal(state.writes.length, 0);
  }
  fixture(); db.distribution.updateMany = async () => ({ count: 0 });
  await assert.rejects(invoke(), error => error.code === 'DISTRIBUTION_STATUS_CHANGED');
  fixture(); db.$transaction = async () => { throw Object.assign(new Error('conflict'), { code: 'P2034' }); };
  await assert.rejects(invoke(), error => error.code === 'DISTRIBUTION_CONCURRENT_CHANGE');
  assert.equal(closeDistributionSchema.safeParse({ notes: '   ' }).success, false);
  assert.equal(closeDistributionSchema.safeParse({ notes: 'x'.repeat(2001) }).success, false);
  assert.equal(closeDistributionSchema.safeParse({ notes: 'Reviewed records.', status: 'CLOSED' }).success, false);
  assert.equal(closeDistributionSchema.parse({ notes: ' Reviewed records. ' }).notes, 'Reviewed records.');
});


test('physical quantities retain voided handovers and block mismatched evidence', async () => {
  const state = fixture();
  Object.assign(state.distribution, { packageName: 'Family food pack', packageUnit: 'pack', packageQuantity: 2 });
  Object.assign(state.claim, { releasedPackageName: 'Family food pack', releasedPackageUnit: 'pack', releasedQuantity: 2 });
  let review = await distributionReconciliation(state.distribution, db);
  assert.equal(review.physicalPackage.recordedQuantity, 2);
  assert.equal(review.physicalPackage.allocatedQuantity, 2);
  assert.equal(review.readyToClose, true);
  state.claim.claimStatus = 'VOIDED';
  review = await distributionReconciliation(state.distribution, db);
  assert.equal(review.physicalReleasedCount, 0, 'Completed claims exclude voided claims.');
  assert.equal(review.physicalPackage.handoverCount, 1, 'The signed log still contains the original handover.');
  assert.equal(review.physicalPackage.recordedQuantity, 2, 'Voiding a claim does not return goods.');
  assert.equal(review.physicalPackage.voidedClaimQuantity, 2);
  for (const mismatch of [{ releasedQuantity: 1 }, { releasedQuantity: null }, { releasedPackageUnit: 'kit' }, { releasedPackageName: 'Different package' }]) {
    Object.assign(state.claim, { releasedQuantity: 2, releasedPackageUnit: 'pack', releasedPackageName: 'Family food pack' }, mismatch);
    review = await distributionReconciliation(state.distribution, db);
    assert.equal(review.readyToClose, false);
    assert.ok(review.exceptions.some(row => row.code === 'PHYSICAL_PACKAGE_MISMATCH'));
  }
  Object.assign(state.distribution, { packageName: null, packageUnit: null, packageQuantity: null });
  Object.assign(state.claim, { releasedPackageName: null, releasedPackageUnit: null, releasedQuantity: null });
  review = await distributionReconciliation(state.distribution, db);
  assert.equal(review.physicalPackage.allocatedQuantity, null);
  assert.equal(review.physicalPackage.quantityNotRecordedCount, 1);
  assert.equal(review.physicalPackage.handoverCount, 1, 'A historical handover still counts when its quantity is unknown.');
  Object.assign(state.claim, { releasedAt: null, releasedById: null });
  review = await distributionReconciliation(state.distribution, db);
  assert.equal(review.physicalPackage.handoverCount, 0, 'An uncompleted claim is not a handover.');
});
