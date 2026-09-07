import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Completions } from "openai/resources/chat/completions";
import { env } from "../src/config/env.js";
import { submitStaffAssistantMessage } from "../src/modules/chatbot/chatbot.controller.js";

async function testServer(t) {
  const previousKey = env.openRouterApiKey;
  env.openRouterApiKey = `sk-or-v1-${"a".repeat(64)}`;
  t.after(() => { env.openRouterApiKey = previousKey; });
  // Controller transport harness; route authentication is covered in chatbot.test.js.
  const app = express();
  app.post("/chat", (req, _res, next) => {
    req.validatedBody = { intent: "HELP", language: "en", messageText: "Contact 09123456789", history: [] };
    req.staffUser = { role: "SYSTEM_ADMIN" };
    next();
  }, submitStaffAssistantMessage);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/chat`;
}

test("HTTP controller flushes answer text before model completion, redacts input, and retains JSON support", { timeout: 5_000 }, async (t) => {
  const url = await testServer(t);
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  t.after(() => finish());
  t.mock.method(Completions.prototype, "create", async function* (body) {
    assert.doesNotMatch(JSON.stringify(body.messages), /09123456789/);
    yield { choices: [{ delta: { content: "Hello staff." } }] };
    await gate;
    yield { choices: [{ delta: {}, finish_reason: "stop" }] };
  });
  const response = await fetch(url, { method: "POST", headers: { Accept: "text/event-stream" } });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.match(response.headers.get("cache-control"), /no-transform/);
  const reader = response.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes('"type":"text"')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    received += decoder.decode(chunk.value);
  }
  assert.match(received, /Hello staff/);
  assert.doesNotMatch(received, /"type":"done"/);
  finish();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value);
  }
  const completed = received.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))).find((event) => event.type === "done");
  assert.equal(completed.data.inputRedacted, true);
  assert.equal(completed.data.messageText, "Hello staff.");
  const legacy = await fetch(url, { method: "POST" });
  assert.equal((await legacy.json()).data.messageText, "Hello staff.");
});

test("closing the HTTP stream cancels its upstream provider request", { timeout: 5_000 }, async (t) => {
  const url = await testServer(t);
  let cancelled;
  const cancellation = new Promise((resolve) => { cancelled = resolve; });
  t.mock.method(Completions.prototype, "create", async function* (_body, { signal }) {
    const abort = new Promise((resolve) => signal.addEventListener("abort", () => { cancelled(); resolve(); }, { once: true }));
    yield { choices: [{ delta: { content: "Starting" } }] };
    await abort;
    signal.throwIfAborted();
  });
  const response = await fetch(url, { method: "POST", headers: { Accept: "text/event-stream" } });
  await response.body.cancel();
  await cancellation;
});
