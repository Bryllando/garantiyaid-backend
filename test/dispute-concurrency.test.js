import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewClaimDisputeSchema } from '../src/modules/distributions/distributionClaimAccountability.schemas.js';

const current = {
  disputeId: 'case-1', claimId: 'claim-1', status: 'UNDER_REVIEW',
  filedBy: { userId: 'filer' }, assignedTo: { userId: 'reviewer' },
  updatedAt: new Date('2026-10-28T01:00:00.000Z'),
  claim: { claimStatus: 'VERIFIED', updatedAt: new Date('2026-10-28T00:30:00Z'), allocation: { amount: '1500' } },
};
let updateWhere, audits = 0, updateCount = 1;
const tx = {
  claim: { updateMany: async () => ({ count: 1 }) },
  claimDispute: {
    findFirst: async () => current,
    updateMany: async ({ where }) => { updateWhere = where; return { count: updateCount }; },
    findUniqueOrThrow: async () => current,
  },
  auditLog: { create: async () => { audits++; } },
};
globalThis.prisma = { distribution: { findFirst: async () => ({ distributionId: 'event-1' }) }, $transaction: async (callback) => callback(tx) };
const { createClaimDispute, reviewClaimDispute } = await import('../src/modules/distributions/distributionClaimAccountability.controller.js');
const invoke = (body, role = 'DSWD_STAFF') => new Promise((resolve, reject) => reviewClaimDispute({
  staffUser: { role }, auth: { userId: 'reviewer' }, headers: {}, socket: {},
  validatedParams: { distributionId: 'event-1', disputeId: 'case-1' },
  validatedBody: reviewClaimDisputeSchema.parse(body),
}, { status() { return this; }, json: resolve }, reject));

test('a filing transaction conflict returns a recoverable response without claiming the concern was saved', async (t) => {
  t.mock.method(globalThis.prisma, '$transaction', async (_callback, options) => {
    assert.equal(options.isolationLevel, 'Serializable');
    throw Object.assign(new Error('Concurrent completion'), { code: 'P2034' });
  });
  await assert.rejects(new Promise((resolve, reject) => createClaimDispute({
    staffUser: { role: 'DSWD_STAFF' }, auth: { userId: 'filer' },
    validatedParams: { distributionId: 'event-1', claimId: 'claim-1' },
    validatedBody: { reasonCode: 'OTHER', statement: 'Beneficiary reports a concern before completion.' },
  }, { status() { return this; }, json: resolve }, reject)), error => error.statusCode === 409 && error.code === 'CLAIM_DISPUTE_CONCURRENT_CHANGE');
});

test('a decision cannot overwrite a case changed since it was opened or during save', async () => {
  const body = { action: 'CONFIRM_CLAIM', reviewNotes: 'Release evidence supports the original claim.', expectedUpdatedAt: '2026-10-28T01:00:00.000Z', expectedClaimUpdatedAt: current.claim.updatedAt.toISOString() };
  assert.equal(reviewClaimDisputeSchema.safeParse({ ...body, expectedUpdatedAt: 'yesterday' }).success, false);
  await assert.rejects(invoke({ ...body, expectedUpdatedAt: '2026-10-27T01:00:00.000Z' }), (error) => error.code === 'CLAIM_DISPUTE_CONCURRENT_CHANGE');
  assert.equal(updateWhere, undefined);
  assert.equal(audits, 0);
  updateCount = 0;
  await assert.rejects(invoke(body), (error) => error.code === 'CLAIM_DISPUTE_CONCURRENT_CHANGE');
  assert.equal(audits, 0);
  updateCount = 1;
  await invoke(body);
  assert.equal(updateWhere.updatedAt.toISOString(), body.expectedUpdatedAt);
  assert.equal(updateWhere.assignedToId, 'reviewer');
  assert.equal(audits, 1);
  await assert.rejects(invoke(body, 'BARANGAY_FACILITATOR'), (error) => error.statusCode === 403);
});

test('clearing a duplicate hold checks the claim version and records a distinct audit action', async (t) => {
  const originalClaim = current.claim;
  t.after(() => { current.claim = originalClaim; delete tx.claim; });
  current.claim = { ...originalClaim, isDuplicateFlag: true, updatedAt: new Date('2026-11-03T01:00:00Z') };
  let claimQuery, changed = 0;
  const actions = [];
  tx.claim = { updateMany: async (args) => { claimQuery = args; return { count: changed }; } };
  t.mock.method(tx.auditLog, 'create', async ({ data }) => actions.push(data.action));
  const body = { action: 'CONFIRM_CLAIM', reviewNotes: 'Original verification checked; repeat scan confirmed.', expectedUpdatedAt: current.updatedAt.toISOString(), expectedClaimUpdatedAt: current.claim.updatedAt.toISOString() };
  await assert.rejects(invoke(body), (error) => error.code === 'CLAIM_DISPUTE_CONCURRENT_CHANGE');
  assert.deepEqual(actions, []);
  assert.deepEqual(claimQuery.where.updatedAt, current.claim.updatedAt);
  assert.equal(claimQuery.where.claimStatus, 'VERIFIED');
  assert.deepEqual(claimQuery.data, { isDuplicateFlag: false });
  changed = 1;
  await invoke(body);
  assert.deepEqual(actions, ['CLAIM_DUPLICATE_FLAG_CLEARED_AFTER_REVIEW', 'CLAIM_DISPUTE_CLAIM_CONFIRMED']);
});

test('decisions require both displayed versions; assignment requires the case version', () => {
  const versions = { expectedUpdatedAt: current.updatedAt.toISOString(), expectedClaimUpdatedAt: current.claim.updatedAt.toISOString() };
  for (const action of ['CONFIRM_CLAIM', 'COMPLETE_REMEDIATION', 'REFER_FOR_INVESTIGATION']) {
    const body = { action, reviewNotes: 'Original verification and release evidence reviewed.', ...versions };
    assert.equal(reviewClaimDisputeSchema.safeParse({ ...body, expectedUpdatedAt: undefined }).success, false);
    assert.equal(reviewClaimDisputeSchema.safeParse({ ...body, expectedClaimUpdatedAt: undefined }).success, false);
    assert.equal(reviewClaimDisputeSchema.safeParse({ ...body, expectedClaimUpdatedAt: 'yesterday' }).success, false);
    assert.equal(reviewClaimDisputeSchema.safeParse(body).success, true);
  }
  assert.equal(reviewClaimDisputeSchema.safeParse({ action: 'START_REVIEW' }).success, false);
  assert.equal(reviewClaimDisputeSchema.safeParse({ action: 'START_REVIEW', expectedUpdatedAt: versions.expectedUpdatedAt }).success, true);
});

test('new claim evidence after opening blocks every decision even if the case version is unchanged', async (t) => {
  const originalClaim = current.claim;
  t.after(() => { current.claim = originalClaim; });
  const expectedClaimUpdatedAt = current.claim.updatedAt.toISOString();
  current.claim = { ...originalClaim, isDuplicateFlag: true, updatedAt: new Date('2026-11-03T02:00:00Z') };
  const previousAudits = audits, previousUpdate = updateWhere;
  for (const action of ['CONFIRM_CLAIM', 'COMPLETE_REMEDIATION', 'REFER_FOR_INVESTIGATION']) {
    await assert.rejects(invoke({ action, reviewNotes: 'Reviewed the evidence originally shown when opening the case.', expectedUpdatedAt: current.updatedAt.toISOString(), expectedClaimUpdatedAt }), (error) => error.code === 'CLAIM_DISPUTE_CONCURRENT_CHANGE');
  }
  assert.equal(audits, previousAudits);
  assert.equal(updateWhere, previousUpdate);
  assert.equal(current.claim.isDuplicateFlag, true);
});

test('confirmation without claim changes and physical remediation also guard the claim during save', async (t) => {
  const originalClaim = current.claim;
  t.after(() => { current.claim = originalClaim; delete tx.claim; });
  let query, count = 0;
  tx.claim = { updateMany: async (args) => { query = args; return { count }; } };
  const body = { action: 'CONFIRM_CLAIM', reviewNotes: 'Verification and recorded release evidence reviewed.', expectedUpdatedAt: current.updatedAt.toISOString(), expectedClaimUpdatedAt: current.claim.updatedAt.toISOString() };
  const previousAudits = audits;
  await assert.rejects(invoke(body), (error) => error.code === 'CLAIM_DISPUTE_CONCURRENT_CHANGE');
  assert.equal(audits, previousAudits);
  assert.deepEqual(query.data, { updatedAt: current.claim.updatedAt });
  assert.equal(query.where.updatedAt.toISOString(), body.expectedClaimUpdatedAt);
  count = 1;
  await invoke(body);
  current.claim = { ...originalClaim, claimStatus: 'CLAIMED', releaseMethod: 'PHYSICAL_GOODS' };
  await invoke({ ...body, action: 'COMPLETE_REMEDIATION' });
  assert.deepEqual(query.data, { claimStatus: 'VOIDED' });
  assert.equal(query.where.updatedAt.toISOString(), body.expectedClaimUpdatedAt);
});
