import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import app from "../src/app.js";
import { env } from "../src/config/env.js";

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("security headers and request correlation are present without technology leakage", async () => {
  const response = await fetch(`${baseUrl}/api/v1/health`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/i);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("CORS rejects an untrusted browser origin", async () => {
  const response = await fetch(`${baseUrl}/api/v1/health`, {
    headers: { origin: "https://attacker.example" },
  });
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error.code, "CORS_ORIGIN_DENIED");
  assert.equal(body.error.requestId, response.headers.get("x-request-id"));
});

test("unsupported body types, malformed JSON, and oversized JSON fail safely", async () => {
  const unsupported = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "not-json",
  });
  assert.equal(unsupported.status, 415);
  assert.equal((await unsupported.json()).error.code, "UNSUPPORTED_MEDIA_TYPE");

  const malformed = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "INVALID_JSON");

  const oversized = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(1_100_000) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, "REQUEST_TOO_LARGE");
});

test("authentication requests are throttled by client address", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    let lastResponse;
    for (let attempt = 0; attempt <= env.authRateLimitPer15Minutes; attempt += 1) {
      lastResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          identifier: "nonexistent.staff",
          password: "DefinitelyWrong123",
        }),
      });
    }

    const body = await lastResponse.json();
    assert.equal(lastResponse.status, 429);
    assert.equal(body.error.code, "RATE_LIMIT_EXCEEDED");
    assert.ok(lastResponse.headers.get("retry-after"));
  } finally {
    console.warn = originalWarn;
  }
});
