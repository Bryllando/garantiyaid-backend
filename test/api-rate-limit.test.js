import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import jwt from 'jsonwebtoken';
import { apiRateLimiter, apiRateLimitKey, authenticationRateLimiter } from '../src/middleware/rateLimit.js';
import { signAccessToken, signTotpSetupToken } from '../src/modules/auth/auth.service.js';
import { env } from '../src/config/env.js';

test('general API limits isolate signed staff identities and cannot be reset using another session', async () => {
  const first = { userId: randomUUID(), role: 'SYSTEM_ADMIN' };
  const second = { userId: randomUUID(), role: 'DSWD_STAFF' };
  const firstToken = signAccessToken(first);
  const app = express();
  app.use(apiRateLimiter);
  app.get('/read', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/read`;
  const request = token => fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  try {
    for (let index = 0; index < env.apiRateLimitPer15Minutes; index++) assert.equal((await request(firstToken)).status, 200);
    const limited = await request(signAccessToken(first));
    assert.equal(limited.status, 429);
    const body = await limited.json();
    assert.equal(body.error.scope, 'garantiyaid-api');
    assert.ok(body.error.retryAfterSeconds > 0 && body.error.retryAfterSeconds <= 900);
    assert.equal(Number(limited.headers.get('retry-after')), body.error.retryAfterSeconds);
    assert.equal((await request(signAccessToken(second))).status, 200, 'A different staff member on the same IP keeps their own budget');
    assert.equal((await request()).status, 200, 'A staff limit must not block public health or sign-in requests');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('forged/expired and setup credentials cannot create authenticated API quota buckets', () => {
  const user = { userId: randomUUID(), role: 'SYSTEM_ADMIN' };
  const req = token => ({ ip: '2001:db8:abcd:1200::1', get: () => token ? `Bearer ${token}` : undefined });
  const anonymous = apiRateLimitKey(req());
  assert.equal(apiRateLimitKey(req('forged.header.signature')), anonymous);
  assert.equal(apiRateLimitKey(req(signTotpSetupToken(user))), anonymous);
  const expired = jwt.sign({ sub: user.userId, type: 'staff' }, env.jwtAccessSecret, { algorithm: 'HS256', issuer: env.jwtIssuer, audience: env.jwtAudience, jwtid: randomUUID(), expiresIn: -1 });
  assert.equal(apiRateLimitKey(req(expired)), anonymous);
  assert.equal(apiRateLimitKey({ ip: '2001:db8:abcd:12ff::2', get: () => undefined }), anonymous, 'IPv6 addresses retain subnet protection');
  assert.equal(apiRateLimitKey(req(signAccessToken(user))), `staff:${user.userId}`);
});

test('login protection still throttles requests by IP independently of staff identity', async () => {
  const app = express();
  app.use(authenticationRateLimiter);
  app.post('/login', (_req, res) => res.status(401).json({ error: 'synthetic failed login' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    let response;
    for (let index = 0; index <= env.authRateLimitPer15Minutes; index++) response = await fetch(`http://127.0.0.1:${server.address().port}/login`, { method: 'POST' });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.scope, 'garantiyaid-authentication');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
