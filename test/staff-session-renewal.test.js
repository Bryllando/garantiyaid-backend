import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import prisma from '../src/lib/prisma.js';
import { env } from '../src/config/env.js';
import { issueAccessToken, continueStaffSession, verifyAccessToken } from '../src/modules/auth/auth.service.js';

test('staff session continuation uses its own per-login credential', async () => {
  const user = { userId: randomUUID(), role: 'DSWD_STAFF' };
  const database = { staffSession: { create: async () => {} } };
  const login = await issueAccessToken(user, { database });
  assert.throws(() => verifyAccessToken(login.continuationToken), { code: 'INVALID_TOKEN' });
  await assert.rejects(continueStaffSession(user, login.sessionId, login.accessToken, database), { code: 'INVALID_SESSION' });
  await assert.rejects(continueStaffSession(user, randomUUID(), login.continuationToken, database), { code: 'INVALID_SESSION' });
});

test('PostgreSQL renews only active sessions and enforces the original shift deadline', { skip: process.env.STAFF_SESSION_DB_TEST !== '1' }, async t => {
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.databaseUrl).hostname));
  const rollback = new Error('Rollback synthetic session');
  await assert.rejects(prisma.$transaction(async tx => {
    const id = randomUUID();
    const user = await tx.user.create({ data: { userId: id, employeeId: 'test-' + id.slice(0, 15), email: id + '@example.invalid', fullName: 'Session test', role: 'DSWD_STAFF', passwordHash: 'disabled-test-account' } });
    const login = await issueAccessToken(user, { database: tx });
    const where = { sessionId: login.sessionId };
    const renew = () => continueStaffSession(user, login.sessionId, login.continuationToken, tx);
    await tx.staffSession.update({ where, data: { expiresAt: new Date(Date.now() + 30000) } });
    const renewed = verifyAccessToken(await renew());
    assert.equal(renewed.jti, login.sessionId);
    assert.ok(renewed.exp * 1000 > Date.now() + 30000);
    const end = renewed.session_end * 1000;
    t.mock.method(Date, 'now', () => end - 90000);
    await tx.staffSession.update({ where, data: { expiresAt: new Date(end - 30000) } });
    const capped = verifyAccessToken(await renew());
    assert.equal(capped.exp, end / 1000);
    assert.equal(capped.exp, capped.session_end);
    for (const data of [{ revokedAt: new Date() }, { revokedAt: null, expiresAt: new Date(0) }]) {
      await tx.staffSession.update({ where, data });
      await assert.rejects(renew(), { code: 'INVALID_SESSION' });
    }
    Date.now.mock.mockImplementation(() => end + 1000);
    await assert.rejects(renew(), { code: 'INVALID_SESSION' });
    throw rollback;
  }), error => error === rollback);
});
