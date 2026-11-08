import assert from 'node:assert/strict';
import test from 'node:test';
import { creditableClaimListQuerySchema } from '../src/modules/wallets/wallet.schemas.js';

// This controller test never connects to the configured database.
const prisma = { distribution: { findFirst: async () => null }, claim: { findMany: async () => [], count: async () => 0 } };
globalThis.prisma = prisma;
const { listCreditableClaims } = await import('../src/modules/wallets/wallet.controller.js');

const distributionId = '11111111-1111-4111-8111-111111111111';
const request = (query, role = 'DSWD_STAFF') => ({ staffUser: { userId: 'staff-1', role }, validatedParams: { distributionId }, validatedQuery: creditableClaimListQuerySchema.parse(query) });
function invoke(req) {
  return new Promise((resolve, reject) => listCreditableClaims(req, { status(value) { assert.equal(value, 200); return this; }, json: resolve }, reject));
}

test('credit queue validates search and pagination without accepting a status override', () => {
  assert.deepEqual(creditableClaimListQuerySchema.parse({ search: ' Maria Santos ', page: '11', pageSize: '10' }), { search: 'Maria Santos', page: 11, pageSize: 10 });
  for (const query of [{ search: 'a'.repeat(101) }, { page: '0' }, { pageSize: '101' }, { status: 'CLAIMED' }]) assert.equal(creditableClaimListQuerySchema.safeParse(query).success, false);
  assert.equal(creditableClaimListQuerySchema.parse({ search: '  ' }).search, undefined);
});

test('full-name search and pagination retain the event, verified-only and dispute safeguards', async (t) => {
  t.mock.method(prisma.distribution, 'findFirst', async () => ({ distributionId, status: 'OPEN', deliveryMode: 'SIMULATED_WALLET' }));
  let listQuery, countQuery;
  t.mock.method(prisma.claim, 'findMany', async (args) => { listQuery = args; return []; });
  t.mock.method(prisma.claim, 'count', async (args) => { countQuery = args; return 105; });
  const result = await invoke(request({ search: 'Maria   Santos', page: 11, pageSize: 10 }));
  assert.equal(listQuery.skip, 100);
  assert.equal(listQuery.take, 10);
  assert.deepEqual(listQuery.where, countQuery.where);
  assert.equal(listQuery.where.distributionId, distributionId);
  assert.equal(listQuery.where.claimStatus, 'VERIFIED');
  assert.equal(listQuery.where.isDuplicateFlag, false);
  assert.deepEqual(listQuery.where.transactions, { none: { transactionType: 'BENEFIT_CREDIT' } });
  assert.deepEqual(listQuery.where.disputes.none.status.in, ['OPEN', 'UNDER_REVIEW', 'REFERRED']);
  assert.deepEqual(listQuery.where.AND.map((part) => part.OR.map((term) => Object.values(term.beneficiary)[0].contains)), [['Maria', 'Maria', 'Maria'], ['Santos', 'Santos', 'Santos']]);
  assert.deepEqual(result.data.pagination, { page: 11, pageSize: 10, total: 105, totalPages: 11 });
  await invoke(request({ search: distributionId }));
  assert.deepEqual(listQuery.where.AND[0].OR[0], { claimId: distributionId });
});

test('queue access still rejects Barangay staff, closed events and physical releases', async (t) => {
  await assert.rejects(invoke(request({}, 'BARANGAY_FACILITATOR')), (error) => error.statusCode === 403);
  for (const distribution of [{ status: 'CLOSED', deliveryMode: 'SIMULATED_WALLET' }, { status: 'OPEN', deliveryMode: 'PHYSICAL_GOODS' }]) {
    const mock = t.mock.method(prisma.distribution, 'findFirst', async () => ({ distributionId, ...distribution }));
    await assert.rejects(invoke(request({})), (error) => error.statusCode === 409);
    mock.mock.restore();
  }
});
