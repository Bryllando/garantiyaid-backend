import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import app from '../src/app.js';
import prisma from '../src/lib/prisma.js';
import { signAccessToken } from '../src/modules/auth/auth.service.js';
import { env } from '../src/config/env.js';
import { staffImportDatabase } from './helpers/staffImportDatabase.js';

let server;
let origin;
function replaceMethod(t, target, name, implementation) {
  const original = target[name];
  target[name] = implementation;
  t.after(() => { target[name] = original; });
}
test.before(async () => { server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}/api/v1/users/import`; });
test.after(async () => { await new Promise(resolve => server.close(resolve)); });

test('import routes require an active administrator session for both preview and confirmation', async t => {
  for (const action of ['preview', 'confirm', 'jobs']) {
    assert.equal((await fetch(`${origin}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  }
  const user = { userId: '11111111-1111-4111-8111-111111111111', role: 'DSWD_STAFF', isActive: true };
  replaceMethod(t, prisma.user, 'findUnique', async () => user);
  replaceMethod(t, prisma.staffSession, 'findFirst', async () => ({ sessionId: 'fixture-session' }));
  for (const role of ['DSWD_STAFF', 'BARANGAY_FACILITATOR']) {
    user.role = role;
    const token = signAccessToken(user);
    for (const action of ['preview', 'confirm', 'jobs']) {
      const response = await fetch(`${origin}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' });
      assert.equal(response.status, 403);
    }
    assert.equal((await fetch(`${origin}/jobs`, { headers: { Authorization: `Bearer ${token}` } })).status, 403);
    assert.equal((await fetch(`${origin}/jobs/11111111-1111-4111-8111-111111111111/results`, { headers: { Authorization: `Bearer ${token}` } })).status, 403);
  }
});

test('administrator preview validates rows through the real HTTP route and does not create staff', async t => {
  const db = staffImportDatabase();
  const user = { userId: '11111111-1111-4111-8111-111111111111', role: 'SYSTEM_ADMIN', isActive: true };
  const encryptionKey = env.fieldEncryptionKey;
  env.fieldEncryptionKey = 'ab'.repeat(32);
  t.after(() => { env.fieldEncryptionKey = encryptionKey; });
  replaceMethod(t, prisma.user, 'findUnique', async () => user);
  replaceMethod(t, prisma.staffSession, 'findFirst', async () => ({ sessionId: 'fixture-session' }));
  replaceMethod(t, prisma.user, 'findMany', db.user.findMany);
  replaceMethod(t, prisma.barangay, 'findMany', db.barangay.findMany);
  replaceMethod(t, prisma.idempotencyRecord, 'create', db.idempotencyRecord.create);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${signAccessToken(user)}` };
  const rows = [{ sourceRow: 2, fullName: 'Import test', email: 'import@example.test', role: 'DSWD_STAFF' }];
  const response = await fetch(`${origin}/preview`, { method: 'POST', headers, body: JSON.stringify({ rows }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { data } = await response.json();
  assert.equal(data.validCount, 1);
  assert.ok(data.approvalId);
  assert.equal(db.state.users.length, 0);
  const rejected = await fetch(`${origin}/confirm`, { method: 'POST', headers, body: JSON.stringify({ rows, approvalId: data.approvalId, confirmed: false }) });
  assert.equal(rejected.status, 400);
  const bulkRows = Array.from({ length: 5000 }, (_, i) => ({ sourceRow: i + 2, fullName: 'Staff name '.repeat(13), email: `bulk-${i}@example.test`, role: 'DSWD_STAFF' }));
  const body = JSON.stringify({ rows: bulkRows });
  assert.ok(Buffer.byteLength(body) > 1024 * 1024);
  const bulk = await fetch(`${origin}/preview`, { method: 'POST', headers, body });
  assert.equal(bulk.status, 200);
  assert.equal((await bulk.json()).data.validCount, 5000);
});
