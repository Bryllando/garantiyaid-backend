import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import app from '../src/app.js';
import prisma from '../src/lib/prisma.js';
import { signAccessToken } from '../src/modules/auth/auth.service.js';

const admin = { userId: '11111111-1111-4111-8111-111111111111', role: 'SYSTEM_ADMIN', isActive: true };
const barangayId = '22222222-2222-4222-8222-222222222222';
let server, origin;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}/api/v1/barangays`; });
test.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
const auth = actor => ({ Authorization: `Bearer ${signAccessToken(actor)}` });
const patch = (body, headers = auth(admin), id = barangayId) => fetch(`${origin}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
function replace(t, object, method, implementation) { const original = object[method]; object[method] = implementation; t.after(() => { object[method] = original; }); }
function fixture(t) {
  let state = { barangay: { barangayId, barangayName: 'Synthetic Barangay', barangayCode: 'TEST-01', city: 'Test City', province: 'Test Province', isActive: true, updatedAt: new Date('2026-11-06') }, facilitators: 0, events: [], audits: [], history: ['retained-beneficiary', 'retained-receipt'] };
  const db = {
    barangay: {
      findUnique: async ({ where }) => where.barangayId === barangayId ? structuredClone(state.barangay) : null,
      update: async ({ data }) => Object.assign(state.barangay, data, { updatedAt: new Date() }),
    },
    user: { count: async () => state.facilitators },
    distribution: { count: async ({ where }) => {
      assert.deepEqual(where, { barangayId, status: { in: ['DRAFT', 'OPEN'] } });
      return state.events.filter(status => where.status.in.includes(status)).length;
    } },
    auditLog: { create: async ({ data }) => { state.audits.push(data); return data; } },
  };
  replace(t, prisma.user, 'findUnique', async () => admin);
  replace(t, prisma.staffSession, 'findFirst', async () => ({ sessionId: 'synthetic-session' }));
  replace(t, prisma.barangay, 'findMany', async ({ where }) => where.isActive && !state.barangay.isActive ? [] : [state.barangay]);
  replace(t, prisma, '$transaction', async (callback, options) => {
    assert.equal(options.isolationLevel, 'Serializable');
    const snapshot = structuredClone(state);
    try { return await callback(db); } catch (error) { state = snapshot; throw error; }
  });
  return { get state() { return state; }, db };
}

test('barangay status changes require an authenticated administrator', async t => {
  assert.equal((await patch({ isActive: false }, {})).status, 401);
  replace(t, prisma.staffSession, 'findFirst', async () => ({ sessionId: 'synthetic-session' }));
  for (const role of ['DSWD_STAFF', 'BARANGAY_FACILITATOR']) {
    const actor = { ...admin, role, barangayId };
    replace(t, prisma.user, 'findUnique', async () => actor);
    for (const isActive of [true, false]) assert.equal((await patch({ isActive }, auth(actor))).status, 403);
  }
});

test('API blocks archive while active facilitators or unfinished events remain', async t => {
  const store = fixture(t);
  store.state.facilitators = 2;
  let response = await patch({ isActive: false });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'BARANGAY_HAS_ACTIVE_FACILITATORS');
  store.state.facilitators = 0;
  for (const status of ['DRAFT', 'OPEN']) {
    store.state.events = [status];
    response = await patch({ isActive: false });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'BARANGAY_HAS_UNFINISHED_DISTRIBUTIONS');
  }
  assert.equal(store.state.barangay.isActive, true);
  assert.equal(store.state.audits.length, 0);
});

test('archive/restore retains history, removes active choices, and safely repeats requests', async t => {
  const store = fixture(t);
  store.state.events = ['CLOSED', 'CANCELLED'];
  const history = structuredClone(store.state.history);
  for (const isActive of [false, false, true, true]) {
    const response = await patch({ isActive });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.barangay.isActive, isActive);
    assert.deepEqual(store.state.history, history);
    const choices = await fetch(origin, { headers: auth(admin) });
    assert.equal((await choices.json()).data.barangays.length, isActive ? 1 : 0);
    const all = await fetch(`${origin}?activeOnly=false`, { headers: auth(admin) });
    assert.equal((await all.json()).data.barangays.length, 1);
  }
  assert.deepEqual(store.state.audits.map(item => item.action), ['BARANGAY_ARCHIVED', 'BARANGAY_RESTORED']);
  assert.deepEqual(store.state.audits[0].details, { changedFields: ['isActive'], previousIsActive: true, isActive: false });
  assert.equal(store.state.audits[0].userId, admin.userId);
  assert.equal(store.state.audits[0].recordId, barangayId);
  const update = await patch({ barangayName: 'Corrected spelling' });
  assert.equal(update.status, 200);
  assert.equal(store.state.audits.at(-1).action, 'BARANGAY_UPDATED');
});

test('missing/invalid barangays and serialization conflicts fail without a status change', async t => {
  const store = fixture(t);
  assert.equal((await patch({ isActive: false }, auth(admin), 'not-a-uuid')).status, 400);
  assert.equal((await patch({ isActive: false }, auth(admin), admin.userId)).status, 404);
  replace(t, prisma, '$transaction', async () => { throw Object.assign(new Error('Concurrent update'), { code: 'P2034' }); });
  const response = await patch({ isActive: false });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'BARANGAY_CHANGED');
  assert.equal(store.state.barangay.isActive, true);
});

test('audit failure rolls back archive and permits a successful retry', async t => {
  const store = fixture(t);
  const create = store.db.auditLog.create;
  store.db.auditLog.create = async () => { throw new Error('Synthetic audit failure'); };
  t.mock.method(console, 'error', () => {});
  assert.equal((await patch({ isActive: false })).status, 500);
  assert.equal(store.state.barangay.isActive, true);
  assert.equal(store.state.audits.length, 0);
  store.db.auditLog.create = create;
  assert.equal((await patch({ isActive: false })).status, 200);
});
