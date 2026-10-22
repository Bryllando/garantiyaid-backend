import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import app from '../src/app.js';
import prisma from '../src/lib/prisma.js';
import { env } from '../src/config/env.js';
import { signAccessToken } from '../src/modules/auth/auth.service.js';
import { beneficiaryImportDatabase } from './helpers/beneficiaryImportDatabase.js';

let server, origin;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}/api/v1/beneficiaries/import`; });
test.after(async () => { await new Promise(resolve => server.close(resolve)); });
const user = { userId: '11111111-1111-4111-8111-111111111111', role: 'SYSTEM_ADMIN', isActive: true };
const barangayId = '22222222-2222-4222-8222-222222222222';
function mock(t, target, method, fn) { const old = target[method]; target[method] = fn; t.after(() => { target[method] = old; }); }
const headers = actor => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${signAccessToken(actor)}` });

test('beneficiary import endpoints require authentication and registration permission', async t => {
  assert.equal((await fetch(`${origin}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const actor = { ...user, role: 'DSWD_STAFF' };
  mock(t, prisma.user, 'findUnique', async () => actor); mock(t, prisma.staffSession, 'findFirst', async () => ({ sessionId: 'fixture' }));
  for (const [path, method] of [['preview', 'POST'], ['jobs', 'POST'], ['jobs', 'GET'], [`jobs/${user.userId}/results`, 'GET'], [`jobs/${user.userId}/resume`, 'POST']]) {
    assert.equal((await fetch(`${origin}/${path}`, { method, headers: headers(actor), ...(method === 'POST' ? { body: '{}' } : {}) })).status, 403);
  }
});

test('real HTTP preview handles 5,000 rows above 1 MB, has no writes and enforces facilitator scope', async t => {
  const db = beneficiaryImportDatabase(); const actor = { ...user };
  db.state.barangays.push({ barangayId, isActive: true, barangayName: 'Test', city: 'Cebu' });
  const key = env.fieldEncryptionKey; env.fieldEncryptionKey = 'cd'.repeat(32); t.after(() => { env.fieldEncryptionKey = key; });
  mock(t, prisma.user, 'findUnique', async () => actor); mock(t, prisma.staffSession, 'findFirst', async () => ({ sessionId: 'fixture' }));
  mock(t, prisma.barangay, 'findMany', db.barangay.findMany); mock(t, prisma.beneficiary, 'findMany', db.beneficiary.findMany); mock(t, prisma.idempotencyRecord, 'create', db.idempotencyRecord.create);
  const rows = Array.from({ length: 5000 }, (_, n) => ({ sourceRow: n + 2, firstName: `Import ${n}`, lastName: 'Fixture', birthDate: '1990-01-12', sex: 'FEMALE', address: 'Test address '.repeat(8), barangayId }));
  const body = JSON.stringify({ rows }); assert.ok(Buffer.byteLength(body) > 1024 * 1024);
  const response = await fetch(`${origin}/preview`, { method: 'POST', headers: headers(actor), body });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json()).data.validCount, 5000);
  assert.equal(db.state.beneficiaries.length, 0);
  actor.role = 'BARANGAY_FACILITATOR'; actor.barangayId = user.userId;
  const denied = await fetch(`${origin}/preview`, { method: 'POST', headers: headers(actor), body: JSON.stringify({ rows: [rows[0]] }) });
  const review = (await denied.json()).data; assert.equal(review.invalidCount, 1); assert.equal(review.approvalId, undefined);
});
