import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import app from '../src/app.js';
import prisma from '../src/lib/prisma.js';
import { signAccessToken } from '../src/modules/auth/auth.service.js';
import { barangayImportDatabase } from './helpers/barangayImportDatabase.js';

let server, origin;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}/api/v1/barangays/import`; });
test.after(() => new Promise(resolve => server.close(resolve)));
function replace(t, target, name, fn) {
  const original = target[name]; target[name] = fn; t.after(() => { target[name] = original; });
}
const user = { userId: '11111111-1111-4111-8111-111111111111', role: 'SYSTEM_ADMIN', isActive: true };
const rows = [{ sourceRow: 3, barangayName: 'Poblacion', barangayCode: '00001', city: 'Test City', province: 'Test Province' }];
const post = (action, body, headers = {}) => fetch(`${origin}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('both barangay import routes reject unauthenticated users and non-admin staff', async t => {
  for (const action of ['preview', 'confirm']) assert.equal((await post(action, {})).status, 401);
  for (const role of ['DSWD_STAFF', 'BARANGAY_FACILITATOR']) {
    await t.test(role, async t => {
      const staff = { ...user, role };
      replace(t, prisma.user, 'findUnique', async () => staff);
      replace(t, prisma.staffSession, 'findFirst', async () => ({ sessionId: 'test-session' }));
      for (const action of ['preview', 'confirm']) assert.equal((await post(action, {}, { Authorization: `Bearer ${signAccessToken(staff)}` })).status, 403);
    });
  }
});

test('administrator can preview, confirm and safely repeat an import through HTTP', async t => {
  const db = barangayImportDatabase();
  replace(t, prisma.user, 'findUnique', async () => user);
  replace(t, prisma.staffSession, 'findFirst', async () => ({ sessionId: 'test-session' }));
  replace(t, prisma.barangay, 'findMany', db.barangay.findMany);
  replace(t, prisma.idempotencyRecord, 'create', db.idempotencyRecord.create);
  replace(t, prisma, '$transaction', db.$transaction);
  const headers = { Authorization: `Bearer ${signAccessToken(user)}` };
  const preview = await post('preview', { rows }, headers);
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('cache-control'), 'no-store');
  const { data } = await preview.json();
  assert.equal(data.rows[0].sourceRow, 3); assert.ok(data.approvalId); assert.equal(db.state.barangays.length, 0);
  const body = { rows, approvalId: data.approvalId, confirmed: true };
  assert.equal((await post('confirm', body, headers)).status, 400);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await post('confirm', body, { ...headers, 'Idempotency-Key': data.approvalId });
    assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = (await response.json()).data;
    assert.equal(result.createdCount, 1); assert.equal(result.replayed, attempt === 1);
  }
  assert.equal(db.state.barangays.length, 1);
  assert.equal((await post('preview', { rows: [{ ...rows[0], isActive: false }] }, headers)).status, 400);
});
