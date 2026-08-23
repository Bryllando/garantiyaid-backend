import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import app from "../src/app.js";
import {
  distributionNotificationRoutes,
  scheduleNotificationRoutes,
} from "../src/modules/notifications/notification.routes.js";
import notificationRoutes from "../src/modules/notifications/notification.routes.js";
import {
  distributionNotificationEnqueueSchema,
  notificationListQuerySchema,
  scheduleNotificationEnqueueSchema,
} from "../src/modules/notifications/notification.schemas.js";
import {
  assertNotificationBarangayAccess,
  assertNotificationRetryAllowed,
  assertNotificationTypeAllowed,
  resolveNotificationBarangay,
} from "../src/modules/notifications/notification.policy.js";
import {
  buildNotificationWhere,
  assertNotificationRetryable,
  createNotificationRows,
  maskRecipient,
  notificationDeduplicationKey,
  notificationPublicSelect,
  notificationRowFromSchedule,
  notificationScheduledFor,
  notificationToResponse,
} from "../src/modules/notifications/notification.service.js";
import {
  MAX_SMS_MESSAGE_LENGTH,
  NOTIFICATION_TYPES,
  renderNotificationTemplate,
} from "../src/modules/notifications/notification.templates.js";
import {
  createSimulatedSmsProvider,
  normalizePhilippineMobileNumber,
  simulatedProviderReference,
} from "../src/modules/notifications/simulatedSms.provider.js";
import {
  enqueueNotificationJobs,
  notificationQueueHealth,
  notificationJobId,
  notificationJobOptions,
} from "../src/queues/notification.queue.js";
import {
  assertIdempotencyRequestMatches,
  idempotencyRequestHash,
  requireIdempotencyKey,
} from "../src/utils/idempotency.js";
import { REALTIME_EVENT_NAMES, sanitizeRealtimePayload } from "../src/realtime/socket.js";
import { sanitizeAuditDetails } from "../src/modules/audit/audit.service.js";
import {
  processNotificationJob,
  markExhaustedNotificationJob,
  RetryableSimulatedSmsError,
} from "../src/workers/notification.processor.js";
import {
  deliverNotificationRelayMessage,
  notificationRelayEnvelope,
} from "../src/realtime/notification.relay.js";
import {
  createRedisConnection,
  createRedisErrorReporter,
  redisConnectionErrorDetails,
  redisTcpKeepAliveDelay,
} from "../src/lib/redis.js";

const notificationId = "11111111-1111-4111-8111-111111111111";
const scheduleId = "22222222-2222-4222-8222-222222222222";
const distributionId = "33333333-3333-4333-8333-333333333333";
const beneficiaryId = "44444444-4444-4444-8444-444444444444";
const barangayA = "55555555-5555-4555-8555-555555555555";
const barangayB = "66666666-6666-4666-8666-666666666666";
const userId = "77777777-7777-4777-8777-777777777777";
const slotStart = new Date("2099-08-20T01:00:00.000Z");
const ignoreNotificationLifecycle = async () => true;

function schedule(overrides = {}) {
  return {
    scheduleId,
    beneficiaryId,
    distributionId,
    queueNumber: 12,
    status: "SCHEDULED",
    beneficiary: {
      beneficiaryId,
      barangayId: barangayA,
      contactNumber: "09171234567",
      status: "ACTIVE",
    },
    slot: {
      slotStart,
      slotEnd: new Date("2099-08-20T01:30:00.000Z"),
    },
    distribution: {
      distributionId,
      title: "Emergency Cash Assistance",
      location: "Barangay Hall",
      status: "OPEN",
      barangayId: barangayA,
    },
    claim: null,
    ...overrides,
  };
}

test("Phase 9 schemas validate UUIDs, filters, dates, types, batches, and delayed reminders", () => {
  const parsed = notificationListQuerySchema.parse({
    page: "2",
    pageSize: "25",
    beneficiaryId,
    distributionId,
    scheduleId,
    channel: "sms",
    notificationType: "schedule_created",
    status: "pending",
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
  });
  assert.equal(parsed.page, 2);
  assert.equal(parsed.channel, "SMS");
  assert.equal(parsed.dateFrom.toISOString(), "2026-07-31T16:00:00.000Z");
  assert.equal(parsed.dateTo.toISOString(), "2026-08-31T15:59:59.999Z");
  assert.equal(notificationListQuerySchema.safeParse({ page: 0 }).success, false);
  assert.equal(notificationListQuerySchema.safeParse({ pageSize: 101 }).success, false);
  assert.equal(notificationListQuerySchema.safeParse({ status: "UNKNOWN" }).success, false);
  assert.equal(notificationListQuerySchema.safeParse({ beneficiaryId: "bad" }).success, false);
  assert.equal(notificationListQuerySchema.safeParse({ dateFrom: "bad" }).success, false);
  assert.equal(distributionNotificationEnqueueSchema.safeParse({
    notificationType: "DISTRIBUTION_REMINDER",
    scheduleIds: [scheduleId, scheduleId],
  }).success, false);
  assert.equal(distributionNotificationEnqueueSchema.safeParse({
    notificationType: "SCHEDULE_CREATED",
    scheduleIds: Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
  }).success, false);
  assert.equal(scheduleNotificationEnqueueSchema.safeParse({
    notificationType: "SCHEDULE_CREATED",
    sendAt: "2099-08-19T10:00:00+08:00",
  }).success, false);
});

test("idempotency keys replay matching requests and reject payload conflicts", () => {
  const key = requireIdempotencyKey({ get: () => notificationId }, "notification enqueueing");
  assert.equal(key, notificationId);
  assert.throws(
    () => requireIdempotencyKey({ get: () => null }, "notification enqueueing"),
    { code: "IDEMPOTENCY_KEY_REQUIRED" },
  );
  const firstHash = idempotencyRequestHash({ notificationType: "SCHEDULE_CREATED", scheduleIds: [scheduleId] });
  const sameHash = idempotencyRequestHash({ scheduleIds: [scheduleId], notificationType: "SCHEDULE_CREATED" });
  const changedHash = idempotencyRequestHash({ notificationType: "SCHEDULE_UPDATED", scheduleIds: [scheduleId] });
  assert.equal(firstHash, sameHash);
  assert.doesNotThrow(() => assertIdempotencyRequestMatches({ requestHash: firstHash }, sameHash));
  assert.throws(
    () => assertIdempotencyRequestMatches({ requestHash: firstHash }, changedHash),
    { code: "IDEMPOTENCY_KEY_REUSED" },
  );
});

test("notification RBAC permits global staff and strictly scopes facilitators", () => {
  const facilitator = { role: "BARANGAY_FACILITATOR", barangayId: barangayA };
  assert.equal(resolveNotificationBarangay({ role: "SYSTEM_ADMIN" }), undefined);
  assert.equal(resolveNotificationBarangay({ role: "DSWD_STAFF" }), undefined);
  assert.equal(resolveNotificationBarangay(facilitator), barangayA);
  assert.doesNotThrow(() => assertNotificationBarangayAccess(facilitator, barangayA));
  assert.throws(() => assertNotificationBarangayAccess(facilitator, barangayB), { code: "FORBIDDEN" });
  assert.throws(
    () => resolveNotificationBarangay({ role: "BARANGAY_FACILITATOR", barangayId: null }),
    { code: "BARANGAY_ASSIGNMENT_REQUIRED" },
  );
  assert.throws(() => assertNotificationRetryAllowed(facilitator), { code: "FORBIDDEN" });
  assert.doesNotThrow(() => assertNotificationRetryAllowed({ role: "DSWD_STAFF" }));
  assert.doesNotThrow(() => assertNotificationTypeAllowed(facilitator, "DISTRIBUTION_REMINDER"));
  assert.throws(() => assertNotificationTypeAllowed(facilitator, "BENEFIT_CREDITED_SIMULATED"), { code: "FORBIDDEN" });
});

test("history filters are deterministic and include the facilitator Barangay relation", () => {
  assert.deepEqual(buildNotificationWhere({
    beneficiaryId,
    distributionId,
    status: "FAILED",
    channel: "SMS",
  }, barangayA), {
    beneficiaryId,
    distributionId,
    channel: "SMS",
    status: "FAILED",
    beneficiary: { is: { barangayId: barangayA } },
  });
});

test("controlled templates cover every approved type, stay short, and omit prohibited data", () => {
  for (const notificationType of NOTIFICATION_TYPES) {
    const message = renderNotificationTemplate(notificationType, {
      distributionTitle: "A".repeat(500),
      location: "B".repeat(500),
      slotStart,
      queueNumber: 12,
    });
    assert.ok(message.length <= MAX_SMS_MESSAGE_LENGTH);
    assert.doesNotMatch(message, /token|password|biometric|philsys|wallet credential/i);
  }
  assert.match(renderNotificationTemplate("BENEFIT_CREDITED_SIMULATED", {
    distributionTitle: "Test",
    location: "Hall",
    slotStart,
    queueNumber: 1,
  }), /SIMULATION.*No real funds/i);
  assert.throws(() => renderNotificationTemplate("ARBITRARY", {}), { code: "NOTIFICATION_TYPE_INVALID" });
});

test("notification rows are server-rendered, deduplicated, delayed safely, and lifecycle checked", () => {
  const now = new Date("2099-08-18T01:00:00.000Z");
  const sendAt = new Date("2099-08-19T01:00:00.000Z");
  const row = notificationRowFromSchedule(schedule(), {
    notificationType: "DISTRIBUTION_REMINDER",
    sendAt,
    initiatedById: userId,
    now,
  });
  assert.equal(row.channel, "SMS");
  assert.equal(row.providerMode, "SIMULATED");
  assert.equal(row.scheduledFor.toISOString(), sendAt.toISOString());
  assert.equal(row.deduplicationKey.length, 64);
  assert.equal(row.message.includes("09171234567"), false);
  assert.equal(
    notificationDeduplicationKey({ scheduleId, notificationType: row.notificationType, message: row.message }),
    notificationDeduplicationKey({ scheduleId, notificationType: row.notificationType, message: row.message }),
  );
  assert.throws(
    () => notificationScheduledFor("DISTRIBUTION_REMINDER", new Date("2099-08-21T00:00:00Z"), slotStart, now),
    { code: "NOTIFICATION_DELAY_INVALID" },
  );
  assert.throws(
    () => notificationRowFromSchedule(schedule({ status: "CANCELLED" }), {
      notificationType: "SCHEDULE_CREATED", initiatedById: userId, now,
    }),
    { code: "NOTIFICATION_LIFECYCLE_INVALID" },
  );
});

test("notification persistence reuses one row for the same deduplication key", async () => {
  let stored = null;
  const database = {
    notification: {
      findUnique: async () => stored,
      create: async ({ data }) => {
        stored = {
          notificationId,
          ...data,
          providerReference: null,
          attemptCount: 0,
          lastErrorCode: null,
          sentAt: null,
          failedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          beneficiary: { contactNumber: "09171234567", barangayId: barangayA },
          schedule: null,
          distribution: null,
        };
        return stored;
      },
    },
  };
  const row = notificationRowFromSchedule(schedule(), {
    notificationType: "SCHEDULE_CREATED",
    initiatedById: userId,
    now: new Date("2099-08-18T01:00:00Z"),
  });
  const first = await createNotificationRows([row], database);
  const second = await createNotificationRows([row], database);
  assert.equal(first.notifications[0].notificationId, second.notifications[0].notificationId);
  assert.equal(first.newlyCreated.length, 1);
  assert.equal(second.newlyCreated.length, 0);
});

test("public notification fields mask recipients and exclude private delivery locks", () => {
  assert.equal(maskRecipient("+63 917 123 4567"), "********4567");
  assert.equal(maskRecipient(null), null);
  assert.equal(notificationPublicSelect.beneficiary.select.contactNumber, true);
  for (const field of ["passwordHash", "philsysNumber", "faceEmbedding", "tokenHash"]) {
    assert.equal(Object.hasOwn(notificationPublicSelect, field), false);
  }
  const response = notificationToResponse({
    notificationId,
    beneficiaryId,
    scheduleId,
    distributionId,
    channel: "SMS",
    message: "Controlled message",
    notificationType: "SCHEDULE_CREATED",
    status: "PENDING",
    providerMode: "SIMULATED",
    providerReference: null,
    simulated: true,
    attemptCount: 0,
    lastErrorCode: null,
    scheduledFor: new Date("2099-08-19T01:00:00Z"),
    sentAt: null,
    failedAt: null,
    createdAt: new Date("2099-08-18T01:00:00Z"),
    updatedAt: new Date("2099-08-18T01:00:00Z"),
    processingToken: "88888888-8888-4888-8888-888888888888",
    beneficiary: { contactNumber: "09171234567", barangayId: barangayA },
    schedule: null,
    distribution: null,
  });
  assert.equal(response.recipientMasked, "*******4567");
  assert.equal(Object.hasOwn(response, "beneficiary"), false);
  assert.equal(Object.hasOwn(response, "processingToken"), false);
  assert.match(response.simulationDisclosure, /no real SMS/i);
  assert.match(response.createdAt, /\+08:00$/);
});

test("simulated SMS provider is deterministic, handles missing contacts, and never calls fetch", async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Network access forbidden");
  };
  try {
    const provider = createSimulatedSmsProvider({ failureMode: "NONE" });
    const success = await provider.send({
      notificationId,
      recipient: "09171234567",
      message: "Controlled",
    });
    assert.equal(success.success, true);
    assert.equal(success.simulated, true);
    assert.equal(success.providerReference, simulatedProviderReference(notificationId));
    assert.equal(normalizePhilippineMobileNumber("0917 123 4567"), "+639171234567");
    assert.equal((await provider.send({ notificationId, recipient: null, message: "Controlled" })).errorCode, "MISSING_RECIPIENT");
    assert.equal((await provider.send({ notificationId, recipient: "123", message: "Controlled" })).errorCode, "INVALID_RECIPIENT");
    const failed = await createSimulatedSmsProvider({ failureMode: "ALWAYS_FAIL" }).send({
      notificationId,
      recipient: "09171234567",
      message: "Controlled",
    });
    assert.deepEqual({ success: failed.success, retryable: failed.retryable, errorCode: failed.errorCode }, {
      success: false,
      retryable: true,
      errorCode: "SIMULATED_PROVIDER_FAILURE",
    });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue jobs use stable IDs, bounded exponential retries, delays, and ID-only payloads", async () => {
  const now = new Date("2099-08-18T01:00:00.000Z");
  const notification = { notificationId, scheduledFor: new Date(now.getTime() + 60_000) };
  const options = notificationJobOptions(notification, now);
  assert.equal(notificationJobId(notificationId), `notification-${notificationId}`);
  assert.ok(options.attempts >= 1 && options.attempts <= 5);
  assert.deepEqual(options.backoff, { type: "exponential", delay: options.backoff.delay });
  assert.equal(options.delay, 60_000);
  let jobs;
  const queue = { addBulk: async (value) => { jobs = value; return value; } };
  await enqueueNotificationJobs([notification], { queue, now });
  assert.deepEqual(jobs[0].data, { notificationId });
  assert.equal(JSON.stringify(jobs[0]).includes("09171234567"), false);
  assert.equal(JSON.stringify(jobs[0]).includes("message"), false);
});

test("queue health is safe and reports a controlled unavailable state", async () => {
  const ready = await notificationQueueHealth({
    queue: {
      waitUntilReady: async () => "PONG",
      getJobCounts: async () => ({ waiting: 1, active: 0, delayed: 2, failed: 0 }),
    },
  });
  assert.equal(ready.status, "ready");
  assert.equal(Object.hasOwn(ready, "redisUrl"), false);
  const unavailable = await notificationQueueHealth({
    queue: { waitUntilReady: async () => { throw new Error("offline"); } },
  });
  assert.deepEqual({ status: unavailable.status, simulatedSmsOnly: unavailable.simulatedSmsOnly }, {
    status: "unavailable", simulatedSmsOnly: true,
  });
  assert.equal(JSON.stringify(unavailable).includes("offline"), false);
});

function workerDatabase({ providerRecipient = "09171234567" } = {}) {
  const state = {
    notification: {
      notificationId,
      beneficiaryId,
      scheduleId,
      distributionId,
      initiatedById: userId,
      channel: "SMS",
      message: "Controlled schedule notification",
      notificationType: "SCHEDULE_CREATED",
      status: "PENDING",
      simulated: true,
      processingToken: null,
      processingStartedAt: null,
      attemptCount: 0,
      beneficiary: { contactNumber: providerRecipient, barangayId: barangayA },
    },
    scheduleNotificationAt: null,
    audits: [],
  };
  const notification = {
    updateMany: async ({ where, data }) => {
      const row = state.notification;
      if (where.notificationId !== row.notificationId || (where.status && where.status !== row.status)) return { count: 0 };
      if (Object.hasOwn(where, "processingToken") && where.processingToken !== row.processingToken) return { count: 0 };
      if (where.OR && row.processingToken && row.processingStartedAt) return { count: 0 };
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && Object.hasOwn(value, "increment")) row[key] += value.increment;
        else row[key] = value;
      }
      return { count: 1 };
    },
    findUnique: async () => ({ ...state.notification, beneficiary: { ...state.notification.beneficiary } }),
  };
  const database = {
    notification,
    schedule: { updateMany: async ({ data }) => { state.scheduleNotificationAt = data.notificationAt; return { count: 1 }; } },
    auditLog: { create: async ({ data }) => { state.audits.push(data); return data; } },
    $transaction: async (callback) => callback(database),
  };
  return { database, state };
}

test("worker atomically transitions PENDING to SENT and updates schedule notificationAt", async () => {
  const { database, state } = workerDatabase();
  let providerCalls = 0;
  const provider = { send: async () => { providerCalls += 1; return {
    success: true, simulated: true, providerReference: "sim_ref", retryable: false,
  }; } };
  const now = new Date("2099-08-18T01:00:00Z");
  const lifecycleEvents = [];
  const result = await processNotificationJob({ data: { notificationId }, attemptsMade: 0, opts: { attempts: 3 } }, {
    database,
    provider,
    now,
    publishLifecycle: async (...event) => { lifecycleEvents.push(event); return true; },
  });
  assert.equal(result.outcome, "SENT_SIMULATED");
  assert.equal(state.notification.status, "SENT");
  assert.equal(state.notification.sentAt, now);
  assert.equal(state.notification.failedAt, null);
  assert.equal(state.notification.attemptCount, 1);
  assert.equal(state.scheduleNotificationAt, now);
  assert.equal(providerCalls, 1);
  assert.equal(state.audits[0].action, "SIMULATED_NOTIFICATION_MARKED_SENT");
  assert.equal(JSON.stringify(state.audits).includes("Controlled schedule notification"), false);
  assert.equal(JSON.stringify(state.audits).includes("09171234567"), false);
  assert.equal(lifecycleEvents[0][0], "notification.sent");
  assert.equal(lifecycleEvents[0][1].notificationId, notificationId);
});

test("worker keeps one row during retry, uses exponential BullMQ attempts, then marks permanent failure", async () => {
  const provider = createSimulatedSmsProvider({ failureMode: "ALWAYS_FAIL" });
  const first = workerDatabase();
  await assert.rejects(
    () => processNotificationJob({ data: { notificationId }, attemptsMade: 0, opts: { attempts: 3 } }, {
      database: first.database, provider, publishLifecycle: ignoreNotificationLifecycle,
    }),
    RetryableSimulatedSmsError,
  );
  assert.equal(first.state.notification.status, "PENDING");
  assert.equal(first.state.notification.attemptCount, 1);
  assert.equal(first.state.audits.length, 0);
  assert.equal(first.state.notification.notificationId, notificationId);

  const final = workerDatabase();
  const result = await processNotificationJob({ data: { notificationId }, attemptsMade: 2, opts: { attempts: 3 } }, {
    database: final.database, provider, publishLifecycle: ignoreNotificationLifecycle,
  });
  assert.equal(result.outcome, "FAILED");
  assert.equal(final.state.notification.status, "FAILED");
  assert.ok(final.state.notification.failedAt instanceof Date);
  assert.equal(final.state.notification.sentAt, null);
  assert.equal(final.state.audits[0].action, "SIMULATED_NOTIFICATION_PERMANENTLY_FAILED");
});

test("missing recipients fail permanently without retries and never update Schedule.notificationAt", async () => {
  const { database, state } = workerDatabase({ providerRecipient: null });
  const result = await processNotificationJob({
    data: { notificationId }, attemptsMade: 0, opts: { attempts: 3 },
  }, {
    database,
    provider: createSimulatedSmsProvider({ failureMode: "NONE" }),
    publishLifecycle: ignoreNotificationLifecycle,
  });
  assert.equal(result.outcome, "FAILED");
  assert.equal(result.errorCode, "MISSING_RECIPIENT");
  assert.equal(state.notification.status, "FAILED");
  assert.equal(state.notification.attemptCount, 1);
  assert.equal(state.scheduleNotificationAt, null);
});

test("manual retry lifecycle accepts FAILED only", () => {
  assert.doesNotThrow(() => assertNotificationRetryable({ status: "FAILED" }));
  for (const status of ["PENDING", "SENT", "READ"]) {
    assert.throws(() => assertNotificationRetryable({ status }), { code: "NOTIFICATION_NOT_RETRYABLE" });
  }
});

test("unexpected BullMQ exhaustion is reflected as a permanent database failure", async () => {
  const { database, state } = workerDatabase();
  state.notification.processingToken = "88888888-8888-4888-8888-888888888888";
  const updated = await markExhaustedNotificationJob(notificationId, {
    database,
    publishLifecycle: ignoreNotificationLifecycle,
  });
  assert.equal(updated, true);
  assert.equal(state.notification.status, "FAILED");
  assert.equal(state.notification.lastErrorCode, "QUEUE_JOB_ATTEMPTS_EXHAUSTED");
  assert.equal(state.audits[0].action, "SIMULATED_NOTIFICATION_PERMANENTLY_FAILED");
});

test("worker concurrency guard allows only one simulated provider call", async () => {
  const { database, state } = workerDatabase();
  let providerCalls = 0;
  const provider = { send: async () => {
    providerCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { success: true, simulated: true, providerReference: "sim_once", retryable: false };
  } };
  const job = { data: { notificationId }, attemptsMade: 0, opts: { attempts: 3 } };
  const results = await Promise.all([
    processNotificationJob(job, { database, provider, publishLifecycle: ignoreNotificationLifecycle }),
    processNotificationJob(job, { database, provider, publishLifecycle: ignoreNotificationLifecycle }),
  ]);
  assert.equal(providerCalls, 1);
  assert.deepEqual(results.map((value) => value.outcome).sort(), ["SENT_SIMULATED", "SKIPPED"]);
  assert.equal(state.notification.status, "SENT");
});

test("notification audit and realtime sanitizers remove messages and recipient data", () => {
  const payload = {
    notificationId,
    message: "Full controlled message",
    recipient: "09171234567",
    contactNumber: "09171234567",
    password: "hidden",
    status: "SENT",
  };
  assert.deepEqual(sanitizeRealtimePayload(payload), { notificationId, status: "SENT" });
  const audit = sanitizeAuditDetails(payload);
  assert.equal(audit.message, "[REDACTED]");
  assert.equal(audit.recipient, "[REDACTED]");
  assert.equal(audit.contactNumber, "[REDACTED]");
});

test("worker notification relay carries only the allowed realtime lifecycle fields", () => {
  const relay = notificationRelayEnvelope("notification.sent", {
    notificationId,
    beneficiaryId,
    scheduleId,
    distributionId,
    channel: "SMS",
    notificationType: "SCHEDULE_UPDATED",
    message: "Do not relay this message",
    beneficiary: { barangayId: barangayA, contactNumber: "09171234567" },
  }, {
    status: "SENT",
    simulated: true,
    realSmsSent: false,
    recipient: "09171234567",
  });
  assert.deepEqual(relay, {
    eventName: "notification.sent",
    distributionId,
    barangayId: barangayA,
    data: {
      notificationId,
      beneficiaryId,
      scheduleId,
      notificationType: "SCHEDULE_UPDATED",
      channel: "SMS",
      status: "SENT",
      simulated: true,
      realSmsSent: false,
    },
  });
  assert.equal(JSON.stringify(relay).includes("09171234567"), false);
  assert.equal(JSON.stringify(relay).includes("Do not relay"), false);
});

test("API relay delivers worker completion and notification metrics events", async () => {
  const published = [];
  const delivered = await deliverNotificationRelayMessage(JSON.stringify({
    eventName: "notification.sent",
    distributionId,
    barangayId: barangayA,
    data: {
      notificationId,
      beneficiaryId,
      scheduleId,
      notificationType: "SCHEDULE_UPDATED",
      channel: "SMS",
      status: "SENT",
      simulated: true,
      realSmsSent: false,
      message: "untrusted extra field",
    },
  }), async (eventName, payload) => { published.push({ eventName, payload }); return true; });
  assert.equal(delivered, true);
  assert.deepEqual(published.map(({ eventName }) => eventName), [
    "notification.sent",
    "notification.metrics.updated",
  ]);
  assert.equal(published[0].payload.data.message, undefined);
  assert.equal(published[1].payload.data.reason, "NOTIFICATION_SENT");
});

test("API relay rejects unsupported worker events", async () => {
  let publishCalls = 0;
  const delivered = await deliverNotificationRelayMessage(JSON.stringify({
    eventName: "wallet.transaction.completed",
    data: { notificationId },
  }), async () => { publishCalls += 1; });
  assert.equal(delivered, false);
  assert.equal(publishCalls, 0);
});

test("Redis retry diagnostics expose the cause, throttle duplicates, and report recovery", () => {
  let timestamp = 1_000;
  const warnings = [];
  const recoveries = [];
  const reporter = createRedisErrorReporter({
    errorEvent: "TEST_REDIS_ERROR",
    recoveryEvent: "TEST_REDIS_RECOVERED",
    logIntervalMs: 5_000,
    now: () => timestamp,
    warn: (entry) => warnings.push(entry),
    info: (entry) => recoveries.push(entry),
  });
  const error = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6379"), {
    code: "ECONNREFUSED",
    errno: -4_078,
    syscall: "connect",
    address: "127.0.0.1",
    port: 6_379,
  });

  assert.deepEqual(redisConnectionErrorDetails(error), {
    errorName: "Error",
    errorCode: "ECONNREFUSED",
    errorMessage: "connect ECONNREFUSED 127.0.0.1:6379",
    errorNumber: -4_078,
    syscall: "connect",
    address: "127.0.0.1",
    port: 6_379,
  });
  assert.equal(reporter.report(error), true);
  timestamp = 2_000;
  assert.equal(reporter.report(error), false);
  timestamp = 6_000;
  assert.equal(reporter.report(error), true);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0].errorCode, "ECONNREFUSED");
  assert.equal(warnings[0].retrying, true);
  assert.equal(warnings[1].suppressedErrors, 1);

  timestamp = 7_000;
  assert.equal(reporter.report(error), false);
  timestamp = 8_000;
  assert.equal(reporter.recovered({ channel: "test:realtime" }), true);
  assert.deepEqual(recoveries, [{
    channel: "test:realtime",
    event: "TEST_REDIS_RECOVERED",
    downtimeMs: 7_000,
    suppressedErrors: 1,
  }]);
  assert.equal(reporter.recovered(), false);
});

test("local Redis avoids the Docker TCP keep-alive reset while remote Redis retains probes", () => {
  const connection = createRedisConnection("garantiyaid-keepalive-test");
  assert.equal(redisTcpKeepAliveDelay("redis://127.0.0.1:6379"), null);
  assert.equal(redisTcpKeepAliveDelay("redis://localhost:6379"), null);
  assert.equal(redisTcpKeepAliveDelay("rediss://cache.internal:6380"), 30_000);
  assert.equal(connection.options.keepAlive, null);
  connection.disconnect(false);
});

test("Phase 9 Socket.IO event vocabulary is server-controlled and complete", () => {
  for (const eventName of [
    "notification.queued",
    "notification.sent",
    "notification.failed",
    "notification.metrics.updated",
  ]) {
    assert.ok(REALTIME_EVENT_NAMES.includes(eventName));
  }
});

function routeSurface(router) {
  return router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`));
}

test("Phase 9 route surface exposes history, summary, health, enqueue, and retry only", () => {
  assert.deepEqual(routeSurface(notificationRoutes).sort(), [
    "GET /",
    "GET /:notificationId",
    "GET /queue/health",
    "GET /summary",
    "POST /:notificationId/retry",
  ].sort());
  assert.deepEqual(routeSurface(distributionNotificationRoutes).sort(), [
    "GET /:distributionId/notifications",
    "POST /:distributionId/notifications/enqueue",
  ].sort());
  assert.deepEqual(routeSurface(scheduleNotificationRoutes), [
    "POST /:scheduleId/notifications/enqueue",
  ]);
});

test("all notification HTTP endpoints reject unauthenticated requests", async () => {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/api/v1`;
  try {
    const requests = [
      fetch(`${base}/notifications`),
      fetch(`${base}/notifications/summary`),
      fetch(`${base}/notifications/queue/health`),
      fetch(`${base}/notifications/${notificationId}`),
      fetch(`${base}/distributions/${distributionId}/notifications`),
      fetch(`${base}/distributions/${distributionId}/notifications/enqueue`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      }),
      fetch(`${base}/schedules/${scheduleId}/notifications/enqueue`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      }),
      fetch(`${base}/notifications/${notificationId}/retry`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      }),
    ];
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map((response) => response.status), Array(8).fill(401));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
