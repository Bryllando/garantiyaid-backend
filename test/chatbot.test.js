import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import app from "../src/app.js";
import chatbotRoutes from "../src/modules/chatbot/chatbot.routes.js";
import {
  CHATBOT_INTENTS,
  CHATBOT_PROTOTYPE_DISCLOSURE,
} from "../src/modules/chatbot/chatbot.constants.js";
import { classifyChatbotIntent } from "../src/modules/chatbot/chatbot.intent.js";
import {
  controlledChatbotAnswer,
  escalationReasonForIntent,
} from "../src/modules/chatbot/chatbot.knowledge.js";
import {
  chatbotEscalateSchema,
  chatbotEscalationListQuerySchema,
  chatbotMessageListQuerySchema,
  chatbotMessageSchema,
  chatbotResolveSchema,
  chatbotSessionParamsSchema,
  createChatbotSessionSchema,
  staffAssistantFeedbackSchema,
  staffAssistantMessageSchema,
} from "../src/modules/chatbot/chatbot.schemas.js";
import {
  assertChatbotReplyOwnership,
  assertChatbotSessionBarangayAccess,
  chatbotEscalationScope,
  resolveChatbotBarangayScope,
} from "../src/modules/chatbot/chatbot.policy.js";
import {
  assertChatbotSessionAcceptsMessages,
  buildChatbotEscalationWhere,
  chatbotMessagePublicSelect,
  chatbotRetentionDeletionWhere,
  chatbotSessionToResponse,
  chatbotSessionTokenMatches,
  createGenericChatbotSession,
  createStaffChatbotReply,
  endGenericChatbotSession,
  getGenericChatbotSession,
  hashChatbotSessionToken,
  listGenericChatbotMessages,
  processGenericChatbotTurn,
  redactChatbotText,
  resolveStaffChatbotEscalation,
} from "../src/modules/chatbot/chatbot.service.js";
import { sanitizeAuditDetails } from "../src/modules/audit/audit.service.js";
import { REALTIME_EVENT_NAMES, sanitizeRealtimePayload } from "../src/realtime/socket.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const beneficiaryId = "22222222-2222-4222-8222-222222222222";
const barangayA = "33333333-3333-4333-8333-333333333333";
const barangayB = "44444444-4444-4444-8444-444444444444";
const staffAId = "55555555-5555-4555-8555-555555555555";
const staffBId = "66666666-6666-4666-8666-666666666666";

function inMemoryChatbotDatabase() {
  const state = { session: null, messages: [], audits: [] };
  const staffById = {
    [staffAId]: { userId: staffAId, employeeId: "DSWD-001", fullName: "Staff A", role: "DSWD_STAFF" },
    [staffBId]: { userId: staffBId, employeeId: "DSWD-002", fullName: "Staff B", role: "DSWD_STAFF" },
  };
  function sessionView() {
    if (!state.session) return null;
    return {
      ...state.session,
      beneficiary: state.session.beneficiaryId ? {
        beneficiaryId,
        firstName: "Sample",
        lastName: "Beneficiary",
        barangayId: state.session.barangayId,
        barangay: { barangayId: state.session.barangayId, barangayName: "Barangay A" },
      } : null,
      assignedStaff: staffById[state.session.assignedStaffId] ?? null,
      resolvedBy: staffById[state.session.resolvedById] ?? null,
      _count: { messages: state.messages.length },
    };
  }
  function statusMatches(where) {
    if (!where?.status) return true;
    if (typeof where.status === "string") return state.session.status === where.status;
    return where.status.in.includes(state.session.status);
  }
  function assignedMatches(where) {
    if (!where?.OR) return true;
    return where.OR.some((condition) => (
      Object.hasOwn(condition, "assignedStaffId")
      && state.session.assignedStaffId === condition.assignedStaffId
    ));
  }
  const database = {
    state,
    $transaction: async (operation) => operation(database),
    chatbotSession: {
      create: async ({ data }) => {
        state.session = {
          sessionId,
          ...data,
          escalationReason: null,
          escalatedAt: null,
          assignedStaffId: null,
          assignedAt: null,
          resolvedById: null,
          resolvedAt: null,
          resolutionCode: null,
          endedAt: null,
          createdAt: data.startedAt,
          updatedAt: data.startedAt,
          barangayId: null,
        };
        return sessionView();
      },
      findUnique: async ({ where }) => where.sessionId === sessionId ? sessionView() : null,
      update: async ({ where, data }) => {
        assert.equal(where.sessionId, sessionId);
        Object.assign(state.session, data, { updatedAt: data.lastActivityAt ?? new Date() });
        return sessionView();
      },
      updateMany: async ({ where, data }) => {
        if (where.sessionId !== sessionId || !statusMatches(where) || !assignedMatches(where)) return { count: 0 };
        Object.assign(state.session, data, { updatedAt: data.lastActivityAt ?? new Date() });
        return { count: 1 };
      },
      findMany: async () => state.session ? [sessionView()] : [],
      count: async () => state.session ? 1 : 0,
    },
    chatbotMessage: {
      count: async () => state.messages.length,
      aggregate: async () => ({
        _max: { sequence: state.messages.at(-1)?.sequence ?? null },
      }),
      create: async ({ data }) => {
        const message = {
          messageId: `${String(data.sequence).padStart(8, "0")}-0000-4000-8000-000000000000`,
          ...data,
          intentDetected: data.intentDetected ?? null,
          confidenceScore: data.confidenceScore ?? null,
          staffUserId: data.staffUserId ?? null,
          createdAt: new Date(Date.UTC(2099, 0, 1, 0, 0, data.sequence)),
          staffUser: staffById[data.staffUserId] ?? null,
        };
        state.messages.push(message);
        return message;
      },
      findMany: async ({ skip = 0, take = 100 }) => state.messages.slice(skip, skip + take),
    },
    auditLog: {
      create: async ({ data }) => {
        state.audits.push(data);
        return data;
      },
    },
  };
  return database;
}

test("chatbot schemas validate UUIDs, pagination, languages, strict fields, and controlled staff actions", () => {
  assert.deepEqual(createChatbotSessionSchema.parse({}), { language: "en" });
  assert.deepEqual(createChatbotSessionSchema.parse({ language: " CEB " }), { language: "ceb" });
  assert.equal(createChatbotSessionSchema.safeParse({ beneficiaryId }).success, false);
  assert.equal(createChatbotSessionSchema.safeParse({ language: "arbitrary" }).success, false);
  assert.equal(chatbotSessionParamsSchema.safeParse({ sessionId }).success, true);
  assert.equal(chatbotSessionParamsSchema.safeParse({ sessionId: "not-a-uuid" }).success, false);
  assert.deepEqual(chatbotMessageListQuerySchema.parse({}), { page: 1, pageSize: 20 });
  assert.equal(chatbotMessageListQuerySchema.safeParse({ pageSize: 51 }).success, false);
  assert.equal(chatbotEscalationListQuerySchema.parse({ assignedToMe: "false" }).assignedToMe, false);
  assert.equal(chatbotEscalateSchema.parse({}).reason, "HUMAN_REQUESTED");
  assert.equal(chatbotResolveSchema.parse({ resolutionCode: "answered" }).resolutionCode, "ANSWERED");
  assert.equal(chatbotResolveSchema.safeParse({ resolutionCode: "DELETE_HISTORY" }).success, false);
  assert.deepEqual(staffAssistantFeedbackSchema.parse({
    rating: "HELPFUL",
    context: "DISTRIBUTION_DRAFT",
    intent: "CREATE_DISTRIBUTION_DRAFT",
  }), {
    rating: "HELPFUL",
    context: "DISTRIBUTION_DRAFT",
    intent: "CREATE_DISTRIBUTION_DRAFT",
  });
  assert.equal(staffAssistantFeedbackSchema.safeParse({
    rating: "HELPFUL",
    context: "GUIDANCE",
    messageText: "Do not store conversation content in feedback.",
  }).success, false);
  assert.deepEqual(staffAssistantMessageSchema.parse({
    intent: "SCHEDULE",
    language: " CEB ",
    messageText: "Asa makita ang schedule?",
  }), {
    intent: "SCHEDULE",
    language: "ceb",
    messageText: "Asa makita ang schedule?",
    history: [],
  });
  assert.equal(staffAssistantMessageSchema.safeParse({
    intent: "DELETE_ACCOUNT",
    language: "en",
    messageText: "Delete this account",
  }).success, false);
});

test("chatbot message validation enforces length, rejects executable HTML, and rejects unknown fields", () => {
  assert.equal(chatbotMessageSchema.parse({ messageText: "  Hello  " }).messageText, "Hello");
  assert.equal(chatbotMessageSchema.safeParse({ messageText: "" }).success, false);
  assert.equal(chatbotMessageSchema.safeParse({ messageText: "x".repeat(1_001) }).success, false);
  assert.equal(chatbotMessageSchema.safeParse({ messageText: "<script>alert(1)</script>" }).success, false);
  assert.equal(chatbotMessageSchema.safeParse({ messageText: "Hello", execute: "SQL" }).success, false);
});

test("intent detection is deterministic, controlled, multilingual-aware, and confidence-bounded", () => {
  const cases = [
    ["Hello", "GREETING"],
    ["What documents do I need?", "DOCUMENT_REQUIREMENTS"],
    ["Tell me about available programs", "PROGRAM_INFORMATION"],
    ["What is this system and how can I apply?", "PROGRAM_INFORMATION"],
    ["When is my schedule?", "DISTRIBUTION_SCHEDULE"],
    ["What is the status of my claim?", "CLAIM_STATUS"],
    ["What is my enrollment status?", "ENROLLMENT_STATUS"],
    ["How do I claim using QR?", "CLAIM_PROCESS"],
    ["I need to talk to a person", "HUMAN_ASSISTANCE"],
    ["Unsaon pag claim?", "CLAIM_PROCESS"],
    ["Write me a poem about volcanoes", "UNKNOWN"],
  ];
  for (const [messageText, expectedIntent] of cases) {
    const first = classifyChatbotIntent(messageText);
    const second = classifyChatbotIntent(messageText);
    assert.deepEqual(first, second);
    assert.equal(first.intent, expectedIntent);
    assert.ok(first.confidence >= 0 && first.confidence <= 1);
    assert.ok(CHATBOT_INTENTS.includes(first.intent));
  }
});

test("controlled answers never claim personal access or external AI and escalate unsafe personal intents", () => {
  for (const language of ["en", "fil", "ceb"]) {
    for (const intent of CHATBOT_INTENTS) {
      const answer = controlledChatbotAnswer(intent, language);
      assert.equal(answer.personalDataAccessed, false);
      assert.equal(answer.externalAiUsed, false);
      assert.equal(answer.prototypeDisclosure, CHATBOT_PROTOTYPE_DISCLOSURE);
      assert.doesNotMatch(answer.messageText, /https?:\/\/|SELECT\s+|wallet transfer completed/i);
    }
  }
  for (const intent of ["DISTRIBUTION_SCHEDULE", "CLAIM_STATUS", "ENROLLMENT_STATUS"]) {
    const answer = controlledChatbotAnswer(intent, "en");
    assert.equal(answer.requiresPersonalAuthentication, true);
    assert.equal(answer.requiresEscalation, true);
    assert.equal(escalationReasonForIntent(intent, 0.99), "PERSONAL_DATA_REQUIRED");
  }
  assert.equal(controlledChatbotAnswer("CLAIM_PROCESS", "en").requiresEscalation, false);
  assert.equal(controlledChatbotAnswer("UNKNOWN", "en").requiresEscalation, true);
});

test("chat text redaction removes credentials, tokens, PhilSys-like IDs, and full contact numbers before storage", () => {
  const result = redactChatbotText(
    "My number is 09171234567, ID 1234-5678-9012, password is Secret123, token ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn",
  );
  assert.equal(result.inputRedacted, true);
  assert.doesNotMatch(result.messageText, /09171234567|1234-5678-9012|Secret123|ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
  assert.match(result.messageText, /REDACTED_CONTACT/);
  assert.match(result.messageText, /REDACTED_IDENTIFIER/);
  assert.match(result.messageText, /REDACTED_CREDENTIAL/);
});

test("anonymous session credentials are high entropy, hashed at rest, and session IDs alone do not authorize access", async () => {
  const database = inMemoryChatbotDatabase();
  const now = new Date("2099-01-01T00:00:00.000Z");
  const created = await createGenericChatbotSession({ language: "en" }, database, now);
  assert.equal(created.sessionToken.length, 43);
  assert.equal(database.state.session.accessTokenHash, hashChatbotSessionToken(created.sessionToken));
  assert.equal(chatbotSessionTokenMatches(created.sessionToken, database.state.session.accessTokenHash), true);
  assert.equal(chatbotSessionTokenMatches("x".repeat(43), database.state.session.accessTokenHash), false);
  assert.equal(database.state.session.beneficiaryId, null);
  assert.equal(Object.hasOwn(created.session, "accessTokenHash"), false);
  await assert.rejects(
    () => getGenericChatbotSession(sessionId, "x".repeat(43), database),
    { code: "CHATBOT_SESSION_NOT_FOUND" },
  );
});

test("multi-turn processing stores deterministic order, controlled bot answers, one escalation transition, and safe audits", async () => {
  const database = inMemoryChatbotDatabase();
  const created = await createGenericChatbotSession(
    { language: "en" },
    database,
    new Date("2099-01-01T00:00:00.000Z"),
  );
  const first = await processGenericChatbotTurn({
    sessionId,
    token: created.sessionToken,
    messageText: "Write me a poem about volcanoes",
    ipAddress: "127.0.0.1",
  }, database, new Date("2099-01-01T00:01:00.000Z"));
  assert.equal(first.classification.intent, "UNKNOWN");
  assert.equal(first.escalatedNow, true);
  assert.equal(first.session.status, "ESCALATED");
  assert.deepEqual(database.state.messages.map((message) => message.sequence), [1, 2]);
  assert.deepEqual(database.state.messages.map((message) => message.senderType), ["USER", "BOT"]);
  assert.equal(database.state.audits[0].action, "CHATBOT_SESSION_ESCALATED");
  assert.equal(database.state.audits[0].userId, null);
  assert.equal(database.state.audits[0].actorType, "SYSTEM");
  assert.equal(JSON.stringify(database.state.audits).includes("volcanoes"), false);

  const second = await processGenericChatbotTurn({
    sessionId,
    token: created.sessionToken,
    messageText: "Hello",
    ipAddress: "127.0.0.1",
  }, database, new Date("2099-01-01T00:02:00.000Z"), async () => null);
  assert.equal(second.classification.intent, "GREETING");
  assert.equal(second.escalatedNow, false);
  assert.deepEqual(database.state.messages.map((message) => message.sequence), [1, 2, 3, 4]);
  assert.equal(database.state.audits.filter((audit) => audit.action === "CHATBOT_SESSION_ESCALATED").length, 1);

  const history = await listGenericChatbotMessages(sessionId, created.sessionToken, {
    page: 1,
    pageSize: 20,
  }, database);
  assert.deepEqual(history.messages.map((message) => message.sequence), [1, 2, 3, 4]);
  assert.deepEqual(history.pagination, { page: 1, pageSize: 20, total: 4, totalPages: 1 });
});

test("safe intents may use external AI wording without forwarding the raw user message", async () => {
  const database = inMemoryChatbotDatabase();
  const created = await createGenericChatbotSession(
    { language: "ceb" },
    database,
    new Date("2099-01-01T00:00:00.000Z"),
  );
  let externalInput;
  const result = await processGenericChatbotTurn({
    sessionId,
    token: created.sessionToken,
    messageText: "Unsaon pag claim? My number is 09171234567",
    ipAddress: "127.0.0.1",
  }, database, new Date("2099-01-01T00:01:00.000Z"), async (input) => {
    externalInput = input;
    return { messageText: "Sunda ang opisyal nga claim process.", model: "safe-test-model" };
  });

  assert.equal(result.externalAiUsed, true);
  assert.equal(result.externalAiModel, "safe-test-model");
  assert.equal(result.botMessage.messageText, "Sunda ang opisyal nga claim process.");
  assert.equal(Object.hasOwn(externalInput, "messageText"), false);
  assert.equal(JSON.stringify(externalInput).includes("09171234567"), false);
  assert.deepEqual(Object.keys(externalInput).sort(), ["approvedAnswer", "intent", "language"]);
});

test("terminal session enforcement blocks all later user and staff messages", async () => {
  const database = inMemoryChatbotDatabase();
  const created = await createGenericChatbotSession(
    { language: "en" },
    database,
    new Date("2099-01-01T00:00:00.000Z"),
  );
  await endGenericChatbotSession({
    sessionId,
    token: created.sessionToken,
    ipAddress: "127.0.0.1",
  }, database, new Date("2099-01-01T00:01:00.000Z"));
  assert.equal(database.state.session.status, "ENDED");
  assert.throws(() => assertChatbotSessionAcceptsMessages(database.state.session), { code: "CHATBOT_SESSION_ENDED" });
  await assert.rejects(() => processGenericChatbotTurn({
    sessionId,
    token: created.sessionToken,
    messageText: "Hello again",
    ipAddress: "127.0.0.1",
  }, database, new Date("2099-01-01T00:02:00.000Z")), { code: "CHATBOT_SESSION_ENDED" });
});

test("staff escalation RBAC isolates Barangays and denies facilitators access to generic sessions", () => {
  const facilitatorA = { userId: staffAId, role: "BARANGAY_FACILITATOR", barangayId: barangayA };
  assert.equal(resolveChatbotBarangayScope({ role: "SYSTEM_ADMIN" }), undefined);
  assert.equal(resolveChatbotBarangayScope({ role: "DSWD_STAFF" }, barangayB), barangayB);
  assert.equal(resolveChatbotBarangayScope(facilitatorA), barangayA);
  assert.throws(() => resolveChatbotBarangayScope(facilitatorA, barangayB), { code: "FORBIDDEN" });
  assert.deepEqual(chatbotEscalationScope(facilitatorA), {
    beneficiary: { is: { barangayId: barangayA } },
  });
  assert.throws(
    () => assertChatbotSessionBarangayAccess(facilitatorA, { beneficiaryId: null, beneficiary: null }),
    { code: "CHATBOT_GENERIC_SESSION_FORBIDDEN" },
  );
  assert.doesNotThrow(() => assertChatbotSessionBarangayAccess(facilitatorA, {
    beneficiaryId,
    beneficiary: { barangayId: barangayA },
  }));
  assert.throws(() => assertChatbotSessionBarangayAccess(facilitatorA, {
    beneficiaryId,
    beneficiary: { barangayId: barangayB },
  }), { code: "FORBIDDEN" });
});

test("staff assignment prevents a second staff member from replying and resolution is explicit and audited", async () => {
  const database = inMemoryChatbotDatabase();
  const created = await createGenericChatbotSession(
    { language: "en" },
    database,
    new Date("2099-01-01T00:00:00.000Z"),
  );
  await processGenericChatbotTurn({
    sessionId,
    token: created.sessionToken,
    messageText: "I need a human",
    ipAddress: "127.0.0.1",
  }, database, new Date("2099-01-01T00:01:00.000Z"));
  const staffA = { ...database.state.session, ...{
    userId: staffAId, employeeId: "DSWD-001", fullName: "Staff A", role: "DSWD_STAFF", barangayId: null,
  } };
  const staffB = { userId: staffBId, employeeId: "DSWD-002", fullName: "Staff B", role: "DSWD_STAFF", barangayId: null };
  const reply = await createStaffChatbotReply({
    sessionId,
    staffUser: staffA,
    messageText: "Please visit the authorized desk with your reference notice.",
    ipAddress: "127.0.0.1",
  }, database, new Date("2099-01-01T00:02:00.000Z"));
  assert.equal(reply.message.senderType, "STAFF");
  assert.equal(database.state.session.assignedStaffId, staffAId);
  assert.throws(() => assertChatbotReplyOwnership(staffB, database.state.session), {
    code: "CHATBOT_SESSION_ASSIGNED",
  });
  await assert.rejects(() => createStaffChatbotReply({
    sessionId,
    staffUser: staffB,
    messageText: "Competing reply",
    ipAddress: "127.0.0.1",
  }, database), { code: "CHATBOT_SESSION_ASSIGNED" });

  const resolved = await resolveStaffChatbotEscalation({
    sessionId,
    staffUser: staffA,
    resolutionCode: "REFERRED_TO_DSWD",
    ipAddress: "127.0.0.1",
  }, database, new Date("2099-01-01T00:03:00.000Z"));
  assert.equal(resolved.session.status, "RESOLVED");
  assert.equal(resolved.session.resolutionCode, "REFERRED_TO_DSWD");
  assert.ok(database.state.audits.some((audit) => audit.action === "CHATBOT_STAFF_REPLIED"));
  assert.ok(database.state.audits.some((audit) => audit.action === "CHATBOT_SESSION_RESOLVED"));
  assert.equal(JSON.stringify(database.state.audits).includes("authorized desk"), false);
});

test("queue filters, response selections, retention rules, audit sanitization, and realtime payloads exclude secrets", () => {
  const facilitator = { userId: staffAId, role: "BARANGAY_FACILITATOR", barangayId: barangayA };
  assert.deepEqual(buildChatbotEscalationWhere(facilitator, {
    status: "ESCALATED",
    assignedToMe: true,
  }), {
    status: "ESCALATED",
    beneficiary: { is: { barangayId: barangayA } },
    assignedStaffId: staffAId,
  });
  assert.deepEqual(chatbotRetentionDeletionWhere(new Date("2099-04-01T00:00:00Z")), {
    status: { in: ["RESOLVED", "ENDED"] },
    retentionUntil: { lte: new Date("2099-04-01T00:00:00Z") },
  });
  assert.equal(Object.hasOwn(chatbotMessagePublicSelect, "accessTokenHash"), false);
  const response = chatbotSessionToResponse({
    sessionId,
    beneficiaryId: null,
    accessTokenHash: "a".repeat(64),
    language: "en",
    status: "ACTIVE",
    isEscalated: false,
    startedAt: new Date(),
    lastActivityAt: new Date(),
    retentionUntil: new Date(),
  });
  assert.equal(Object.hasOwn(response, "accessTokenHash"), false);
  const audit = sanitizeAuditDetails({ messageText: "private", sessionToken: "private", resolutionCode: "ANSWERED" });
  assert.equal(audit.messageText, "[REDACTED]");
  assert.equal(audit.sessionToken, "[REDACTED]");
  assert.equal(audit.resolutionCode, "ANSWERED");
  assert.deepEqual(sanitizeRealtimePayload({
    sessionId,
    status: "ESCALATED",
    messageText: "private",
    accessToken: "secret",
  }), { sessionId, status: "ESCALATED" });
});

test("Phase 10 route surface is bounded, rate-limited, and exposes no edit, delete, or bulk endpoints", async () => {
  const routes = chatbotRoutes.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).sort(),
      handlers: layer.route.stack.map((handler) => handler.name),
    }));
  const expected = [
    ["/staff-assistant/messages", "post"],
    ["/staff-feedback", "post"],
    ["/sessions", "post"],
    ["/sessions/:sessionId", "get"],
    ["/sessions/:sessionId/messages", "get"],
    ["/sessions/:sessionId/messages", "post"],
    ["/sessions/:sessionId/escalate", "post"],
    ["/sessions/:sessionId/end", "post"],
    ["/escalations", "get"],
    ["/escalations/:sessionId", "get"],
    ["/escalations/:sessionId/reply", "post"],
    ["/escalations/:sessionId/resolve", "post"],
  ];
  assert.deepEqual(routes.map((route) => [route.path, route.methods[0]]), expected);
  assert.equal(routes.some((route) => /edit|delete|bulk|impersonate/i.test(route.path)), false);
  const routeSource = await readFile(new URL("../src/modules/chatbot/chatbot.routes.js", import.meta.url), "utf8");
  assert.equal((routeSource.match(/chatbotRateLimiter/g) ?? []).length >= routes.length, true);
  for (const route of routes.filter((entry) => entry.path.startsWith("/escalations"))) {
    assert.ok(route.handlers.includes("wrappedHandler"));
    assert.ok(route.handlers.includes("authorizeRequest"));
  }
});

test("staff endpoints require authentication and anonymous session creation rejects beneficiary ownership claims", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const staffResponse = await fetch(`${baseUrl}/api/v1/chatbot/escalations`);
    assert.equal(staffResponse.status, 401);
    const feedbackResponse = await fetch(`${baseUrl}/api/v1/chatbot/staff-feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: "HELPFUL", context: "GUIDANCE" }),
    });
    assert.equal(feedbackResponse.status, 401);
    const staffAssistantResponse = await fetch(`${baseUrl}/api/v1/chatbot/staff-assistant/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "HELP", language: "en" }),
    });
    assert.equal(staffAssistantResponse.status, 401);
    const privateCreate = await fetch(`${baseUrl}/api/v1/chatbot/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "en", beneficiaryId }),
    });
    assert.equal(privateCreate.status, 400);
    assert.equal((await privateCreate.json()).error.code, "VALIDATION_ERROR");
    const missingToken = await fetch(`${baseUrl}/api/v1/chatbot/sessions/${sessionId}`);
    assert.equal(missingToken.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("dedicated chatbot rate limiting rejects excess requests before session-token processing", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/chatbot/sessions/${sessionId}`;
  try {
    let limitedResponse = null;
    for (let attempt = 0; attempt < 35; attempt += 1) {
      const response = await fetch(url);
      if (response.status === 429) {
        limitedResponse = response;
        break;
      }
      assert.equal(response.status, 401);
    }
    assert.ok(limitedResponse, "The chatbot limiter should reject requests within its configured 30-request window.");
    assert.equal((await limitedResponse.json()).error.code, "RATE_LIMIT_EXCEEDED");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Phase 10 realtime vocabulary remains server-controlled and carries no conversation text", () => {
  for (const eventName of [
    "chatbot.session.escalated",
    "chatbot.staff_reply.created",
    "chatbot.session.resolved",
    "chatbot.metrics.updated",
  ]) {
    assert.ok(REALTIME_EVENT_NAMES.includes(eventName));
  }
});

test("controlled chatbot code has no external network, arbitrary SQL, tool, or code-execution path", async () => {
  const files = [
    "../src/modules/chatbot/chatbot.intent.js",
    "../src/modules/chatbot/chatbot.knowledge.js",
    "../src/modules/chatbot/chatbot.service.js",
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bfetch\s*\(|node:https?|child_process|\beval\s*\(|\bFunction\s*\(|queryRawUnsafe|executeRawUnsafe/);
  }
  const knowledgeSource = await readFile(
    new URL("../src/modules/chatbot/chatbot.knowledge.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(knowledgeSource, /prisma|database|walletAccount|qrToken|claim\.find|schedule\.find/i);
});
