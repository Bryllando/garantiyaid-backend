import test from 'node:test';
import assert from 'node:assert/strict';
import { distributionListQuerySchema } from '../src/modules/distributions/distribution.schemas.js';

const database = { distribution: { findMany: async () => [], count: async () => 0 } };
globalThis.prisma = database;
const { listDistributions } = await import('../src/modules/distributions/distribution.controller.js');
const invoke = (staffUser, query) => new Promise((resolve, reject) => listDistributions({ staffUser, validatedQuery: distributionListQuerySchema.parse(query) }, { status(value) { assert.equal(value, 200); return this; }, json: resolve }, reject));

test('event search validates text and date boundaries', () => {
  assert.equal(distributionListQuerySchema.parse({ search: ' Rain aid ' }).search, 'Rain aid');
  assert.equal(distributionListQuerySchema.parse({ search: '  ' }).search, undefined);
  assert.equal(distributionListQuerySchema.safeParse({ search: 'a'.repeat(101) }).success, false);
  assert.equal(distributionListQuerySchema.safeParse({ dateFrom: '2026-10-31', dateTo: '2026-10-01' }).success, false);
});

test('event search retains authorized scope, filters and pagination in both list and count', async (t) => {
  let listed, counted;
  t.mock.method(database.distribution, 'findMany', async (query) => { listed = query; return []; });
  t.mock.method(database.distribution, 'count', async (query) => { counted = query; return 105; });
  const barangayId = '11111111-1111-4111-8111-111111111111';
  const result = await invoke({ role: 'BARANGAY_FACILITATOR', barangayId }, { search: 'Rain', status: 'OPEN', page: 14, pageSize: 8, dateFrom: '2026-10-01' });
  assert.equal(listed.skip, 104);
  assert.equal(listed.take, 8);
  assert.equal(listed.where.barangayId, barangayId);
  assert.equal(listed.where.status, 'OPEN');
  assert.ok(listed.where.distributionDate.gte instanceof Date);
  assert.deepEqual(listed.where.OR, [{ title: { contains: 'Rain', mode: 'insensitive' } }, { location: { contains: 'Rain', mode: 'insensitive' } }]);
  assert.deepEqual(listed.where, counted.where);
  assert.equal(result.data.pagination.totalPages, 14);
  await assert.rejects(invoke({ role: 'BARANGAY_FACILITATOR', barangayId }, { barangayId: '22222222-2222-4222-8222-222222222222' }), (error) => error.statusCode === 403);
});
