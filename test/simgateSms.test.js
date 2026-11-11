import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createSimgateSmsProvider } from "../src/modules/notifications/simgateSms.provider.js";

const input = { recipient: "0917 123 4567", message: "GarantiyAid test notification" };
const options = { apiKey: "test-key", deviceId: "test-device", timeoutMs: 1000 };

test("SimGate uses the documented endpoint, backend header and E.164 payload for online and queued acceptance", async () => {
  for (const [status, queued] of [[200, false], [202, true]]) {
    let calls = 0;
    const provider = createSimgateSmsProvider({ ...options, fetchImpl: async (url, request) => {
      calls++;
      assert.equal(url, "https://api.simgate.app/v1/sms/send");
      assert.equal(request.method, "POST");
      assert.equal(request.headers["x-api-key"], "test-key");
      assert.equal(request.redirect, "error");
      assert.deepEqual(JSON.parse(request.body), { deviceId: "test-device", phoneNumber: "+639171234567", message: input.message });
      return Response.json({ success: true, queued, messageId: "test-message-id" }, { status });
    } });
    const result = await provider.send(input);
    assert.deepEqual(result, { success: true, simulated: false, retryable: false, providerReference: "test-message-id" });
    assert.equal(calls, 1);
  }
});

test("SimGate validates recipients, message length and configuration before network access", async () => {
  const fetchImpl = async () => { throw new Error("Unexpected network request"); };
  const provider = createSimgateSmsProvider({ ...options, fetchImpl });
  for (const [values, errorCode] of [
    [{ ...input, recipient: null }, "MISSING_RECIPIENT"],
    [{ ...input, recipient: "123" }, "INVALID_RECIPIENT"],
    [{ ...input, message: " " }, "INVALID_MESSAGE"],
    [{ ...input, message: "a".repeat(321) }, "INVALID_MESSAGE"],
  ]) assert.equal((await provider.send(values)).errorCode, errorCode);
  assert.equal((await createSimgateSmsProvider({ ...options, apiKey: "", fetchImpl }).send(input)).errorCode, "SIMGATE_NOT_CONFIGURED");
});

test("SimGate rejects quota/auth errors and never automatically retries an ambiguous submission", async () => {
  for (const status of [400, 401, 403, 404, 422, 429]) {
    const result = await createSimgateSmsProvider({ ...options, fetchImpl: async () => Response.json({ secret: "not exposed" }, { status }) }).send(input);
    assert.deepEqual(result, { success: false, simulated: false, retryable: false, errorCode: `SIMGATE_SEND_${status}` });
  }
  for (const fetchImpl of [
    async () => { throw new DOMException("timeout", "TimeoutError"); },
    async () => Response.json({ success: true, messageId: "accepted-but-invalid-response" }),
    async () => Response.json({ success: false }, { status: 500 }),
    async () => new Response("not JSON"),
  ]) {
    const result = await createSimgateSmsProvider({ ...options, fetchImpl }).send(input);
    assert.equal(result.errorCode, "SIMGATE_DELIVERY_UNCONFIRMED");
    assert.equal(result.retryable, false);
  }
});

test("SimGate mode requires both secrets, while simulation remains available without them", () => {
  const base = { ...process.env, NODE_ENV: "test", SMS_PROVIDER_MODE: "SIMGATE", SIMGATE_API_KEY: "", SIMGATE_DEVICE_ID: "" };
  const run = (overrides) => spawnSync(process.execPath, ["--input-type=module", "-e", "import './src/config/env.js'"], { env: { ...base, ...overrides }, encoding: "utf8" });
  const missing = run({});
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /SIMGATE_API_KEY.*SIMGATE_DEVICE_ID/);
  assert.equal(run({ SMS_PROVIDER_MODE: "SIMULATED" }).status, 0);
  assert.equal(run({ SIMGATE_API_KEY: "test-key", SIMGATE_DEVICE_ID: "test-device" }).status, 0);
});
