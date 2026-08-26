import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../src/config/env.js";
import {
  accountIsLocked,
  generateRecoveryCodes,
  hashRecoveryCode,
  nextLoginFailureState,
  signAccessToken,
  verifyAccessToken,
} from "../src/modules/auth/auth.service.js";
import {
  findValidTotpCounter,
  verifyTotpCode,
} from "../src/modules/auth/totp.service.js";
import {
  loginPasswordSchema,
  newStaffPasswordSchema,
} from "../src/modules/auth/password.schemas.js";

const user = {
  userId: "11111111-1111-4111-8111-111111111111",
  role: "SYSTEM_ADMIN",
};

function rfcTotp(secret, timestamp) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret) {
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  const counter = Math.floor(timestamp / 30_000);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counterBuffer).digest();
  const offset = digest.at(-1) & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

function durationSeconds(value) {
  const amount = Number.parseInt(value, 10);
  const multipliers = { s: 1, m: 60, h: 60 * 60, d: 24 * 60 * 60 };
  return amount * multipliers[value.at(-1)];
}

test("staff JWTs use an explicit algorithm, issuer, audience, expiry, and UUID jti", () => {
  const token = signAccessToken(user);
  const header = jwt.decode(token, { complete: true }).header;
  const payload = verifyAccessToken(token);

  assert.equal(header.alg, "HS256");
  assert.equal(payload.iss, env.jwtIssuer);
  assert.equal(payload.aud, env.jwtAudience);
  assert.match(payload.jti, /^[0-9a-f-]{36}$/i);
  assert.ok(payload.exp > payload.iat);
  assert.equal(payload.exp - payload.iat, durationSeconds(env.jwtAccessExpiresIn));
  if (env.nodeEnv === "production") {
    assert.ok(payload.exp - payload.iat <= 60 * 60);
  }
});

test("access-token verification rejects an unapproved algorithm and wrong issuer", () => {
  const wrongAlgorithm = jwt.sign(
    { sub: user.userId, type: "staff" },
    env.jwtAccessSecret,
    {
      algorithm: "HS384",
      issuer: env.jwtIssuer,
      audience: env.jwtAudience,
      jwtid: "22222222-2222-4222-8222-222222222222",
      expiresIn: "15m",
    },
  );
  const wrongIssuer = jwt.sign(
    { sub: user.userId, type: "staff" },
    env.jwtAccessSecret,
    {
      algorithm: "HS256",
      issuer: "different-service",
      audience: env.jwtAudience,
      jwtid: "22222222-2222-4222-8222-222222222222",
      expiresIn: "15m",
    },
  );

  assert.throws(() => verifyAccessToken(wrongAlgorithm), { code: "INVALID_TOKEN" });
  assert.throws(() => verifyAccessToken(wrongIssuer), { code: "INVALID_TOKEN" });
});

test("login lockout resets stale failures and locks at the configured threshold", () => {
  const now = new Date("2026-08-12T12:00:00.000Z");
  let state = {
    failedLoginAttempts: 0,
    lastFailedLoginAt: null,
    lockedUntil: null,
  };

  for (let attempt = 1; attempt <= env.authMaxFailedAttempts; attempt += 1) {
    state = nextLoginFailureState(state, new Date(now.getTime() + attempt * 1_000));
  }

  assert.equal(state.isNowLocked, true);
  assert.equal(state.failedLoginAttempts, env.authMaxFailedAttempts);
  assert.equal(accountIsLocked(state, now), true);

  const staleState = nextLoginFailureState({
    ...state,
    failedLoginAttempts: 19,
    lastFailedLoginAt: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
    lockedUntil: new Date(now.getTime() - 1_000),
  }, now);
  assert.equal(staleState.failedLoginAttempts, 1);
  assert.equal(staleState.isNowLocked, false);
});

test("TOTP verification returns a replay-protection counter for a valid code", () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const timestamp = 1_786_512_345_000;
  const code = rfcTotp(secret, timestamp);
  const counter = findValidTotpCounter(secret, code, timestamp);

  assert.equal(counter, BigInt(Math.floor(timestamp / 30_000)));
  assert.equal(verifyTotpCode(secret, "not-six-digits"), false);
});

test("password policy enforces 12 characters for new staff and bcrypt's byte limit", () => {
  assert.equal(newStaffPasswordSchema.safeParse("Short123").success, false);
  assert.equal(newStaffPasswordSchema.safeParse("A secure 12+ character passphrase").success, true);
  assert.equal(loginPasswordSchema.safeParse("😀".repeat(19)).success, false);
});

test("staff recovery codes are unique, normalized, and safe to store as hashes", () => {
  const codes = generateRecoveryCodes();

  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  assert.equal(codes.every((code) => /^(?:[A-F0-9]{4}-){3}[A-F0-9]{4}$/.test(code)), true);
  assert.equal(hashRecoveryCode(codes[0]), hashRecoveryCode(codes[0].toLowerCase().replaceAll("-", "")));
  assert.notEqual(hashRecoveryCode(codes[0]), codes[0]);
});
