import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import bcrypt from 'bcrypt';
import { env } from '../src/config/env.js';
import prisma from '../src/lib/prisma.js';
import { verifyAccessToken } from '../src/modules/auth/auth.service.js';
import { authenticateSocketConnection } from '../src/realtime/socket.js';
import { authorizeRoles } from '../src/middleware/authorize.js';
import { assertDevAdminRequest, devAdminConfigurationError, DEV_ADMIN_USERNAME } from '../src/modules/auth/devAdmin.policy.js';
import app from '../src/app.js';

const configuration = {
  nodeEnv: 'development', devQuickLoginEnabled: true, devAdminDatabase: 'dev_admin_fixture',
  databaseUrl: 'postgresql://fixture:fixture@127.0.0.1/dev_admin_fixture', trustProxyHops: 0,
  corsOrigins: ['http://localhost:5173'],
};
const request = () => ({ headers: { host: '127.0.0.1:4000', origin: configuration.corsOrigins[0] }, socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' } });
let server, origin;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}/api/v1`; });
test.after(() => new Promise(resolve => server.close(resolve)));

function replace(t, target, name, implementation) {
  const old = target[name]; target[name] = implementation; t.after(() => { target[name] = old; });
}
async function fixture(t) {
  const before = { ...env }; Object.assign(env, configuration); t.after(() => Object.assign(env, before));
  const user = { userId: '11111111-1111-4111-8111-111111111111', employeeId: 'DEV-ADMIN', username: 'dev.admin', fullName: 'Developer Admin', email: 'dev-admin@garantiyaid.invalid', role: 'SYSTEM_ADMIN', isActive: true, archivedAt: null, mustChangePassword: false, totpEnabled: false, lockedUntil: null, failedLoginAttempts: 0, passwordHash: await bcrypt.hash('fixture-only-password', 4) };
  const sessions = new Map(), audits = [];
  const select = (row, fields) => fields ? Object.fromEntries(Object.keys(fields).map(key => [key, row[key] ?? null])) : { ...row };
  replace(t, prisma.user, 'findUnique', async ({ select: fields }) => select(user, fields));
  replace(t, prisma.user, 'findMany', async () => [{ ...user }]);
  replace(t, prisma.user, 'update', async ({ data }) => Object.assign(user, data));
  replace(t, prisma.staffSession, 'create', async ({ data }) => { sessions.set(data.sessionId, { ...data }); return data; });
  replace(t, prisma.staffSession, 'findFirst', async ({ where }) => {
    const session = sessions.get(where.sessionId);
    return session && session.userId === where.userId && !session.revokedAt && session.expiresAt > new Date() ? { sessionId: session.sessionId } : null;
  });
  replace(t, prisma.staffSession, 'updateMany', async ({ where, data }) => { const session = sessions.get(where.sessionId); if (session) Object.assign(session, data); return { count: session ? 1 : 0 }; });
  replace(t, prisma.auditLog, 'create', async ({ data }) => { audits.push(data); return data; });
  replace(t, prisma, '$transaction', callback => callback(prisma));
  return { user, sessions, audits };
}
const headers = token => ({ Origin: configuration.corsOrigins[0], 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
const post = (path, body = {}, token) => fetch(`${origin}${path}`, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
async function developerLogin() {
  const response = await post('/auth/login', { identifier: 'DEV-ADMIN', password: 'fixture-only-password' });
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

test('developer configuration is opt-in, local, development-only and explicit about its database', () => {
  assert.match(DEV_ADMIN_USERNAME, /^[a-z][a-z0-9._]{3,29}$/, 'Keep the dedicated username compatible with the existing database constraint.');
  assert.equal(devAdminConfigurationError(configuration), null);
  for (const change of [{ nodeEnv: 'production' }, { nodeEnv: 'test' }, { trustProxyHops: 1 }, { devAdminDatabase: 'another_database' }, { devAdminDatabase: '' }, { databaseUrl: 'postgresql://x:x@remote.example/dev_admin_fixture' }, { corsOrigins: ['https://public.example'] }]) {
    assert.ok(devAdminConfigurationError({ ...configuration, ...change }));
  }
  assert.equal(devAdminConfigurationError({ ...configuration, nodeEnv: 'production', devQuickLoginEnabled: false }), null);
});

test('request guards reject non-local peers, spoofed proxy addresses, hosts and origins', () => {
  assert.doesNotThrow(() => assertDevAdminRequest(request(), configuration, { requireOrigin: true }));
  for (const change of [
    { socket: { remoteAddress: '192.0.2.1', localAddress: '127.0.0.1' } },
    { socket: { remoteAddress: '192.0.2.1', localAddress: '127.0.0.1' }, headers: { ...request().headers, 'x-forwarded-for': '127.0.0.1' } },
    { socket: { remoteAddress: '127.0.0.1', localAddress: '0.0.0.0' } },
    { headers: { ...request().headers, host: 'public.example' } },
    { headers: { ...request().headers, host: 'evil.example@localhost' } },
    { headers: { ...request().headers, host: 'localhost:4000/path' } },
    { headers: { ...request().headers, origin: 'http://localhost:9999' } },
    { headers: { ...request().headers, origin: undefined } },
    { headers: { ...request().headers, 'sec-fetch-site': 'cross-site' } },
  ]) assert.throws(() => assertDevAdminRequest({ ...request(), ...change }, configuration, { requireOrigin: true }), { statusCode: 403 });
});

test('developer credentials create a real expiring Admin session, safe response and audit; logout revokes it', async t => {
  const { sessions, audits } = await fixture(t);
  const result = await developerLogin();
  assert.equal(result.user.role, 'SYSTEM_ADMIN');
  assert.equal(result.user.employeeId, 'DEV-ADMIN');
  assert.equal(result.user.passwordHash, undefined);
  const payload = verifyAccessToken(result.accessToken);
  assert.equal(payload.sub, result.user.userId); assert.ok(payload.exp > payload.iat);
  assert.equal(sessions.size, 1); assert.equal(audits[0].action, 'STAFF_LOGIN');
  assert.equal(audits[0].details.authenticationMethod, 'LOCAL_DEVELOPER_PASSWORD');
  assert.equal(JSON.stringify(audits).includes(result.accessToken), false);
  assert.equal((await fetch(`${origin}/auth/me`, { headers: headers(result.accessToken) })).status, 200);
  assert.equal((await post('/auth/logout', {}, result.accessToken)).status, 200);
  assert.equal((await fetch(`${origin}/auth/me`, { headers: headers(result.accessToken) })).status, 401);
});

test('DEV-ADMIN password login skips manual TOTP only in permitted local development', async t => {
  await fixture(t);
  assert.equal((await post('/auth/login', { identifier: 'DEV-ADMIN' })).status, 400);
  const invalid = await post('/auth/login', { identifier: 'DEV-ADMIN', password: 'incorrect-password' });
  assert.equal(invalid.status, 401);
  const response = await post('/auth/login', { identifier: 'DEV-ADMIN', password: 'fixture-only-password' });
  assert.equal(response.status, 200);
  const result = (await response.json()).data;
  assert.ok(result.accessToken); assert.equal(result.requiresTotp, undefined);
  env.devQuickLoginEnabled = false;
  assert.equal((await post('/auth/login', { identifier: 'DEV-ADMIN', password: 'fixture-only-password' })).status, 403);
});

test('ordinary staff retain TOTP enrollment and developer credentials cannot select another user or role', async t => {
  const { user, sessions } = await fixture(t);
  assert.equal((await post('/auth/login', { identifier: 'DEV-ADMIN', password: 'fixture-only-password', userId: user.userId, role: 'DSWD_STAFF' })).status, 400);
  Object.assign(user, { employeeId: 'ADMIN-ORDINARY', username: 'ordinary.admin' });
  const response = await post('/auth/login', { identifier: 'ordinary.admin', password: 'fixture-only-password' });
  assert.equal((await response.json()).data.requiresTotpEnrollment, true);
  assert.equal(sessions.size, 0);
});

test('inactive, archived, reassigned and locked developer accounts cannot sign in', async t => {
  const { user, sessions } = await fixture(t);
  for (const change of [{ isActive: false }, { archivedAt: new Date() }, { role: 'DSWD_STAFF' }, { lockedUntil: new Date(Date.now() + 60000) }]) {
    const previous = { ...user }; Object.assign(user, change);
    assert.ok([403, 429].includes((await post('/auth/login', { identifier: 'DEV-ADMIN', password: 'fixture-only-password' })).status));
    Object.assign(user, previous);
  }
  assert.equal(sessions.size, 0);
});

test('developer bearer sessions remain scoped to local dev, expiry and existing role permissions', async t => {
  const { sessions } = await fixture(t);
  assert.equal((await fetch(`${origin}/auth/me`)).status, 401);
  const { accessToken } = await developerLogin();
  const me = () => fetch(`${origin}/auth/me`, { headers: headers(accessToken) });
  env.devQuickLoginEnabled = false; assert.equal((await me()).status, 403);
  env.devQuickLoginEnabled = true; env.nodeEnv = 'production'; assert.equal((await me()).status, 403);
  env.nodeEnv = 'development';
  sessions.values().next().value.expiresAt = new Date(Date.now() - 1000);
  assert.equal((await me()).status, 401);
  let forbidden;
  authorizeRoles('BARANGAY_FACILITATOR')({ auth: { role: 'SYSTEM_ADMIN' } }, {}, error => { forbidden = error; });
  assert.equal(forbidden.statusCode, 403);
});

test('realtime connections enforce the same developer environment and local request guards', async t => {
  await fixture(t);
  const { accessToken } = await developerLogin();
  const socket = { handshake: { auth: { accessToken }, headers: {} }, request: request() };
  assert.equal((await authenticateSocketConnection(socket)).role, 'SYSTEM_ADMIN');
  env.devQuickLoginEnabled = false;
  await assert.rejects(authenticateSocketConnection(socket), { code: 'DEV_LOGIN_UNAVAILABLE' });
  env.devQuickLoginEnabled = true;
  socket.request.socket.remoteAddress = '192.0.2.1';
  await assert.rejects(authenticateSocketConnection(socket), { code: 'DEV_LOGIN_LOCAL_ONLY' });
});

test('passwordless developer endpoints are absent even when local developer login is enabled', async t => {
  const { sessions, audits } = await fixture(t);
  for (const enabled of [true, false]) {
    env.devQuickLoginEnabled = enabled;
    assert.equal((await fetch(`${origin}/auth/dev-admin`, { headers: headers() })).status, 404);
    assert.equal((await post('/auth/dev-admin/login')).status, 404);
  }
  assert.equal(sessions.size, 0); assert.equal(audits.length, 0);
});

test('auth router exposes no separate developer login and production refuses an enabled flag', async () => {
  const { default: routes } = await import('../src/modules/auth/auth.routes.js?disabled-dev-qa');
  assert.equal(routes.stack.some(layer => layer.route?.path.startsWith('/dev-admin')), false);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import './src/config/env.js'"], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', DEV_QUICK_LOGIN_ENABLED: 'true' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Developer Admin login is allowed only in development/);
});
