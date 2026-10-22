import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import app from '../src/app.js';
import prisma from '../src/lib/prisma.js';
import { env } from '../src/config/env.js';
import { signAccessToken } from '../src/modules/auth/auth.service.js';
import { programImportDatabase } from './helpers/programImportDatabase.js';

let server, origin;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}/api/v1/programs/import`; });
test.after(async () => { await new Promise(resolve => server.close(resolve)); });
const user = { userId: '11111111-1111-4111-8111-111111111111', role: 'SYSTEM_ADMIN', isActive: true };
function mock(t, target, method, fn) { const old = target[method]; target[method] = fn; t.after(() => { target[method] = old; }); }
const headers = actor => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${signAccessToken(actor)}` });

test('program import endpoints require authentication and program management permission', async t => {
  assert.equal((await fetch(`${origin}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const actor = { ...user, role: 'BARANGAY_FACILITATOR' };
  mock(t, prisma.user, 'findUnique', async () => actor); mock(t, prisma.staffSession, 'findFirst', async () => ({ sessionId: 'fixture' }));
  for (const [path, method] of [['preview', 'POST'], ['jobs', 'POST'], ['jobs', 'GET'], [`jobs/${user.userId}/results`, 'GET'], [`jobs/${user.userId}/resume`, 'POST']]) {
    assert.equal((await fetch(`${origin}/${path}`, { method, headers: headers(actor), ...(method === 'POST' ? { body: '{}' } : {}) })).status, 403);
  }
});

test('real HTTP preview handles 5,000 rows above 1 MB, has no writes and accepts DSWD program managers', async t => {
  const db = programImportDatabase(); const actor = { ...user, role: 'DSWD_STAFF' };
  const key = env.fieldEncryptionKey; env.fieldEncryptionKey = 'cd'.repeat(32); t.after(() => { env.fieldEncryptionKey = key; });
  mock(t, prisma.user, 'findUnique', async () => actor); mock(t, prisma.staffSession, 'findFirst', async () => ({ sessionId: 'fixture' }));
  mock(t, prisma.program, 'findMany', db.program.findMany); mock(t, prisma.idempotencyRecord, 'create', db.idempotencyRecord.create);
  const rows = Array.from({ length: 5000 }, (_, n) => ({ sourceRow: n + 2, programName: `Program ${n}`, programCode: `TEST-${n}`, programType: 'CASH', description: 'Program details '.repeat(20) }));
  const body = JSON.stringify({ rows }); assert.ok(Buffer.byteLength(body) > 1024 * 1024);
  const response = await fetch(`${origin}/preview`, { method: 'POST', headers: headers(actor), body });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json()).data.validCount, 5000);
  assert.equal(db.state.programs.length, 0);
});
