import test from "node:test";
import assert from "node:assert/strict";
import {
  externalChatbotIntentAllowed,
  generateExternalChatbotAnswer,
  generateStaffAssistantAnswer,
} from "../src/modules/chatbot/chatbot.ai.js";
import { NVIDIA_MODEL } from "../src/lib/nvidia.js";

const testApiKey = `nvapi-${"a".repeat(64)}`;

test("staff streaming clears an interrupted draft before streaming the fallback", async () => {
  const events = [];
  let calls = 0;
  async function* stream() {
    if (++calls === 1) {
      yield { choices: [{ delta: { content: "Unfinished draft" } }] };
      throw new Error("Stream disconnected");
    }
    yield { choices: [{ delta: { content: "Complete reply." } }] };
    assert.deepEqual(events, ["Unfinished draft", "", "retrying", "Complete reply."]);
    yield { choices: [{ delta: {}, finish_reason: "stop" }] };
  }
  const result = await generateStaffAssistantAnswer({ intent: "HELP", language: "en", messageText: "Help me" }, {
    apiKey: testApiKey,
    client: { chat: { completions: { create: async () => stream() } } },
    onText: (text) => events.push(text),
    onStatus: (status) => events.push(status),
  });
  assert.equal(calls, 2);
  assert.equal(result.messageText, "Complete reply.");
  assert.equal(result.externalAiUsed, true);
});

test("client cancellation aborts generation without invoking the fallback", async () => {
  const controller = new AbortController();
  let calls = 0;
  async function* stream() {
    yield { choices: [{ delta: { content: "First words" } }] };
    controller.abort();
    yield { choices: [{ delta: { content: "Never displayed" } }] };
  }
  const received = [];
  await assert.rejects(generateStaffAssistantAnswer({ intent: "HELP", language: "en", messageText: "Help me" }, {
    apiKey: testApiKey,
    signal: controller.signal,
    onText: (text) => received.push(text),
    client: { chat: { completions: { create: async () => { calls++; return stream(); } } } },
  }), { name: "AbortError" });
  assert.equal(calls, 1);
  assert.deepEqual(received, ["First words"]);
});

test("a provider EOF or token limit cannot silently finalize a partial answer", async () => {
  for (const finishReason of [undefined, "length"]) {
    const result = await generateExternalChatbotAnswer({
      intent: "STAFF_HELP", apiKey: testApiKey,
      client: { chat: { completions: { create: async function* () {
        yield { choices: [{ delta: { content: "Incomplete" }, finish_reason: finishReason }] };
      } } } },
    });
    assert.equal(result, null);
  }
});

test("NVIDIA streams only an approved abstract answer and keeps reasoning private", async () => {
  let request;
  let requestOptions;
  async function* stream() {
    yield { choices: [{ delta: { reasoning_content: "PRIVATE REASONING", reasoning: "PRIVATE REASONING" } }] };
    yield { choices: [{ delta: { content: "Approved " } }] };
    yield { choices: [{ delta: { content: "guidance." } }] };
    yield { choices: [{ delta: {}, finish_reason: "stop" }] };
  }
  const result = await generateExternalChatbotAnswer({
    intent: "DOCUMENT_REQUIREMENTS",
    language: "ceb",
    approvedAnswer: "Bring only documents listed by authorized staff.",
    apiKey: testApiKey,
    client: {
      chat: { completions: { create: async (body, options) => {
        request = body;
        requestOptions = options;
        return stream();
      } } },
    },
  });

  assert.deepEqual(result, { messageText: "Approved guidance.", model: NVIDIA_MODEL });
  assert.equal(request.model, NVIDIA_MODEL);
  assert.equal(request.stream, true);
  assert.ok(requestOptions.signal instanceof AbortSignal);
  assert.equal(request.reasoning, undefined);
  assert.equal(request.reasoning_effort, "low");
  assert.deepEqual(JSON.parse(request.messages[1].content), {
    language: "ceb",
    intent: "DOCUMENT_REQUIREMENTS",
    approvedAnswer: "Bring only documents listed by authorized staff.",
  });
});

test("personal and escalated intents never call the external model", async () => {
  let calls = 0;
  assert.equal(externalChatbotIntentAllowed("CLAIM_STATUS"), false);
  const result = await generateExternalChatbotAnswer({
    intent: "CLAIM_STATUS",
    language: "en",
    approvedAnswer: "Staff verification is required.",
    apiKey: testApiKey,
    client: { chat: { completions: { create: async () => { calls += 1; } } } },
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
});

test("a timed-out stream never returns a partial answer", async () => {
  async function* stream() {
    yield { choices: [{ delta: { content: "Incomplete," } }] };
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const result = await generateExternalChatbotAnswer({
    intent: "STAFF_HELP",
    language: "en",
    approvedAnswer: "Approved guidance.",
    apiKey: testApiKey,
    timeoutMs: 1,
    client: { chat: { completions: { create: async () => stream() } } },
  });

  assert.equal(result, null);
});

test("staff guidance uses the current question and bounded conversation context", async () => {
  let request;
  async function* stream() {
    yield { choices: [{ delta: { content: "Review the authorized schedule workspace." } }] };
    yield { choices: [{ delta: {}, finish_reason: "stop" }] };
  }
  const result = await generateStaffAssistantAnswer({
    intent: "SCHEDULE",
    language: "ceb",
    messageText: "Asa makita ang schedule?",
    history: [{ role: "user", content: "Hello" }, { role: "assistant", content: "Maayong adlaw!" }],
    staffRole: "DSWD_STAFF",
  }, {
    apiKey: testApiKey,
    client: { chat: { completions: { create: async (body) => {
      request = body;
      return stream();
    } } } },
  });

  assert.equal(result.externalAiUsed, true);
  assert.equal(result.inputProcessedExternally, true);
  assert.equal(result.messageText, "Review the authorized schedule workspace.");
  assert.equal(request.stream, true);
  assert.match(request.messages[0].content, /Approved guidance:/);
  assert.deepEqual(request.messages.slice(1), [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Maayong adlaw!" },
    { role: "user", content: "Asa makita ang schedule?" },
  ]);
});

test("staff guidance returns a controlled reply when NVIDIA times out", async () => {
  const result = await generateStaffAssistantAnswer({
    intent: "HELP",
    language: "ceb",
    messageText: "Tabangi ko.",
    staffRole: "BARANGAY_FACILITATOR",
  }, {
    apiKey: testApiKey,
    client: { chat: { completions: { create: async () => {
      throw new DOMException("Timed out", "TimeoutError");
    } } } },
  });

  assert.equal(result.externalAiUsed, false);
  assert.equal(result.inputProcessedExternally, false);
  assert.match(result.messageText, /Makatabang ko/);
});

test("staff guidance retries the selected NVIDIA model after a failed request", async () => {
  const requestedModels = [];
  async function* stream() {
    yield { model: NVIDIA_MODEL, choices: [{ delta: { content: "Natural AI reply." } }] };
    yield { choices: [{ delta: {}, finish_reason: "stop" }] };
  }
  const result = await generateStaffAssistantAnswer({
    intent: "HELP",
    language: "en",
    messageText: "What can you help me with?",
    staffRole: "SYSTEM_ADMIN",
  }, {
    apiKey: testApiKey,
    client: { chat: { completions: { create: async ({ model }) => {
      requestedModels.push(model);
      if (requestedModels.length === 1) throw new Error("Provider unavailable");
      return stream();
    } } } },
  });

  assert.deepEqual(requestedModels, [NVIDIA_MODEL, NVIDIA_MODEL]);
  assert.equal(result.messageText, "Natural AI reply.");
  assert.equal(result.externalAiUsed, true);
  assert.equal(result.externalAiModel, NVIDIA_MODEL);
});

test("simple staff greetings answer immediately without waiting for the large model", async () => {
  let calls = 0;
  const result = await generateStaffAssistantAnswer({
    intent: "GREETING",
    language: "ceb",
    messageText: "Hello",
    staffRole: "SYSTEM_ADMIN",
  }, {
    apiKey: testApiKey,
    client: { chat: { completions: { create: async () => { calls += 1; } } } },
  });

  assert.equal(calls, 0);
  assert.equal(result.externalAiUsed, false);
  assert.match(result.messageText, /motubag ko/);
});

test("short follow-ups keep the previous user's topic without trusting assistant-invented facts", async () => {
  for (const [previous, followUp, expected] of [
    ['Asa ang AI schedule?', 'asa ko mosulod ani?', 'Generate AI draft'],
    ['Where can I review distribution slots?', 'what next?', 'Generate AI draft'],
    ['Where can I review SMS delivery?', 'explain more', 'Gateway accepted'],
    ['Asa ang beneficiary records?', 'unya?', 'Sitio'],
  ]) {
    let prompt;
    const result = await generateStaffAssistantAnswer({ intent: 'HELP', language: 'en', messageText: followUp, staffRole: 'BARANGAY_FACILITATOR', history: [{ role: 'user', content: previous }, { role: 'assistant', content: 'Invented: all claims are already approved.' }] }, {
      apiKey: testApiKey,
      client: { chat: { completions: { create: async function* (body) { prompt = body.messages[0].content; yield { choices: [{ delta: { content: 'Grounded follow-up.' }, finish_reason: 'stop' }] }; } } } },
    });
    assert.equal(result.externalAiUsed, true);
    assert.ok(prompt.includes(expected));
    assert.equal(prompt.includes('Invented:'), false);
    assert.match(prompt, /previous assistant replies are not a source of verified facts/i);
    assert.match(prompt, /BARANGAY_FACILITATOR/);
  }
  let calls = 0;
  const fallback = await generateStaffAssistantAnswer({ intent: 'HELP', language: 'en', messageText: 'what next?', history: [{ role: 'assistant', content: 'A schedule was generated.' }] }, { apiKey: '', client: { chat: { completions: { create() { calls++; } } } } });
  assert.equal(calls, 0);
  assert.match(fallback.messageText, /I can guide you/);
});

test("general AI questions receive approved scheduler facts, while an unavailable model returns concise help", async () => {
  let prompt;
  const input = { intent: 'HELP', language: 'ceb', messageText: 'Unsa ang AI ani ug unsay akong buhaton?', staffRole: 'SYSTEM_ADMIN' };
  await generateStaffAssistantAnswer(input, { apiKey: testApiKey, client: { chat: { completions: { create: async function* (body) { prompt = body.messages[0].content; yield { choices: [{ delta: { content: 'Tubag.' }, finish_reason: 'stop' }] }; } } } } });
  assert.match(prompt, /Generate AI draft/);
  assert.match(prompt, /Confirm and save draft schedule/);
  assert.match(prompt, /Requested language: ceb/);
  assert.match(prompt, /leaves the event DRAFT/);
  assert.match(prompt, /do not display internal role codes/);
  const fallback = await generateStaffAssistantAnswer(input, { apiKey: '' });
  assert.match(fallback.messageText, /^Makatabang ko/);
  assert.ok(fallback.messageText.length < 250);
});
