import test from 'node:test';
import assert from 'node:assert/strict';

// All slot writes below use an in-memory database stub.
const database = {
  distribution: { findFirst: async () => null },
  distributionSlot: {
    count: async () => 0,
    findFirst: async () => null,
    findMany: async () => [],
    createMany: async () => {},
    updateMany: async () => ({ count: 1 }),
  },
  schedule: { count: async () => 0 },
  auditLog: { create: async () => {} },
  $transaction: async operation => operation(database),
};
globalThis.prisma = database;
const { generateDistributionSlots, updateDistributionSlot } = await import('../src/modules/distributions/distributionSlot.controller.js');
const { default: routes } = await import('../src/modules/distributions/distribution.routes.js');

const distributionId = '11111111-1111-4111-8111-111111111111';
const barangayId = '22222222-2222-4222-8222-222222222222';
const slotId = '33333333-3333-4333-8333-333333333333';
const event = {
  distributionId, barangayId, status: 'DRAFT', location: 'Barangay Hall',
  distributionDate: new Date('2099-08-20'), slotDurationMinutes: 30,
  startTime: new Date('1970-01-01T08:00:00Z'), endTime: new Date('1970-01-01T09:00:00Z'),
};
const slot = { slotId, distributionId, capacity: 10, slotStatus: 'AVAILABLE', slotStart: new Date('2099-08-20T00:00:00Z'), slotEnd: new Date('2099-08-20T00:30:00Z') };
function request(role = 'BARANGAY_FACILITATOR', assignedBarangay = barangayId) {
  return { auth: { userId: 'staff', role }, staffUser: { role, barangayId: assignedBarangay }, validatedParams: { distributionId, slotId }, validatedBody: { capacity: 20 } };
}
function invoke(handler, req) {
  return new Promise((resolve, reject) => handler(req, { status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, ...body }); } }, reject));
}

test('slot generation and capacity routes allow Admin and Barangay; event administration stays restricted', () => {
  for (const [path, method, allowed] of [
    ['/:distributionId/slots/generate', 'post', ['SYSTEM_ADMIN', 'BARANGAY_FACILITATOR']],
    ['/:distributionId/slots/:slotId', 'patch', ['SYSTEM_ADMIN', 'BARANGAY_FACILITATOR']],
    ['/:distributionId/slots/:slotId/close', 'post', ['SYSTEM_ADMIN']],
    ['/:distributionId/slots/:slotId/reopen', 'post', ['SYSTEM_ADMIN']],
    ['/', 'post', ['SYSTEM_ADMIN']],
  ]) {
    const route = routes.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route;
    for (const role of ['SYSTEM_ADMIN', 'BARANGAY_FACILITATOR', 'DSWD_STAFF', 'BENEFICIARY']) {
      let error;
      route.stack[0].handle({ auth: { role } }, {}, result => { error = result; });
      assert.equal(error?.statusCode, allowed.includes(role) ? undefined : 403, `${role}: ${path}`);
    }
  }
});

test('Admin and assigned Barangay generate slots with scoped lookup, serializable writes and audit records', async t => {
  let rows, audit;
  t.mock.method(database.distributionSlot, 'createMany', async ({ data }) => { rows = data; });
  t.mock.method(database.distributionSlot, 'findMany', async () => rows.map(row => ({ ...row, slotId })));
  t.mock.method(database.auditLog, 'create', async ({ data }) => { audit = data; });
  t.mock.method(database, '$transaction', async (operation, options) => {
    assert.equal(options.isolationLevel, 'Serializable');
    return operation(database);
  });
  for (const role of ['SYSTEM_ADMIN', 'BARANGAY_FACILITATOR']) {
    const lookup = t.mock.method(database.distribution, 'findFirst', async ({ where }) => {
      assert.deepEqual(where, { distributionId, ...(role === 'BARANGAY_FACILITATOR' ? { barangayId } : {}) });
      return event;
    });
    const result = await invoke(generateDistributionSlots, request(role));
    assert.equal(result.status, 201);
    assert.equal(result.data.summary.totalCapacity, 40);
    assert.equal(rows.length, 2);
    assert.equal(audit.action, 'DISTRIBUTION_SLOTS_GENERATED');
    assert.equal(audit.userId, 'staff');
    lookup.mock.restore();
  }
});

test('assigned Barangay can update capacity without changing existing appointments', async t => {
  let saved, audit;
  t.mock.method(database.distribution, 'findFirst', async ({ where }) => {
    assert.deepEqual(where, { distributionId, barangayId });
    return event;
  });
  t.mock.method(database.distributionSlot, 'findFirst', async () => ({ ...slot, ...saved }));
  t.mock.method(database.schedule, 'count', async () => 3);
  t.mock.method(database.distributionSlot, 'updateMany', async ({ data }) => { saved = data; return { count: 1 }; });
  t.mock.method(database.auditLog, 'create', async ({ data }) => { audit = data; });
  const result = await invoke(updateDistributionSlot, request());
  assert.equal(result.status, 200);
  assert.deepEqual(saved, { capacity: 20, slotStatus: 'AVAILABLE' });
  assert.equal(audit.action, 'DISTRIBUTION_SLOT_CAPACITY_UPDATED');
  await assert.rejects(invoke(updateDistributionSlot, { ...request(), validatedBody: { capacity: 2 } }), error => error.code === 'DISTRIBUTION_SLOT_CAPACITY_BELOW_USAGE');
});

test('slot writes reject other barangays, missing assignments, DSWD and non-draft events', async t => {
  const writes = t.mock.method(database, '$transaction', async operation => operation(database));
  for (const handler of [generateDistributionSlots, updateDistributionSlot]) {
    await assert.rejects(invoke(handler, request('DSWD_STAFF')), error => error.statusCode === 403);
    assert.equal(writes.mock.callCount(), 0);
  }
  t.mock.method(database.distribution, 'findFirst', async ({ where }) => where.barangayId === barangayId ? event : null);
  for (const handler of [generateDistributionSlots, updateDistributionSlot]) {
    await assert.rejects(invoke(handler, request('BARANGAY_FACILITATOR', 'other-barangay')), error => error.statusCode === 404);
    await assert.rejects(invoke(handler, request('BARANGAY_FACILITATOR', null)), error => error.code === 'BARANGAY_ASSIGNMENT_REQUIRED');
    for (const status of ['OPEN', 'CLOSED', 'CANCELLED']) {
      const lookup = t.mock.method(database.distribution, 'findFirst', async () => ({ ...event, status }));
      await assert.rejects(invoke(handler, request()), error => error.code === 'DISTRIBUTION_SLOTS_NOT_EDITABLE');
      lookup.mock.restore();
    }
  }
});
