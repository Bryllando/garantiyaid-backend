import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/config/env.js";
import { createBrevoApiProvider, brevoApiProvider } from "../src/modules/staffNotifications/brevoApi.provider.js";
import { gmailApiProvider } from "../src/modules/staffNotifications/gmailApi.provider.js";
import { createStaffSecurityNotification, emailDeliveryConfiguration } from "../src/modules/staffNotifications/staffSecurityEmail.service.js";
import { staffNotificationToResponse } from "../src/modules/staffNotifications/staffNotification.service.js";
import { processStaffEmailJob, RetryableStaffEmailError } from "../src/workers/staffEmail.processor.js";
import { renderStaffEmail } from "../src/modules/staffNotifications/staffEmail.template.js";

const notificationId = "11111111-1111-4111-8111-111111111111";
const message = {
  notificationId, recipient: "staff@example.test", recipientName: "Maria <script>",
  subject: "Password changed\r\nBcc: other@example.test", message: "Your password was changed. <img src=x>",
  targetPath: "/account?section=password", occurredAt: new Date("2026-10-26T01:00:00Z"),
};
const providerOptions = { apiKey: "test-secret-only", senderEmail: "sender@example.test", senderName: "GarantiyAid", publicAppUrl: "https://garantiyaid.example.test" };
const accepted = () => ({ ok: true, status: 201, json: async () => ({ messageId: "brevo-message-1" }) });

test("email has a readable fallback for the same reset link and preserves escaped paragraphs", () => {
  const rendered = renderStaffEmail({ ...message, message: "First paragraph <script>\n\nSecond paragraph & next line\nKeep this detail.", targetPath: "/reset-password?token=test-only&source=email" }, providerOptions.publicAppUrl);
  const links = [...rendered.htmlContent.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(links, Array(2).fill(`${providerOptions.publicAppUrl}/reset-password?token=test-only&amp;source=email`));
  assert.match(rendered.htmlContent, /First paragraph &lt;script&gt;<\/p>/);
  assert.match(rendered.htmlContent, /Second paragraph &amp; next line<br>Keep this detail\./);
  assert.match(rendered.htmlContent, /If the button does not open/);
  assert.match(rendered.textContent, /Reset password: https:\/\/garantiyaid\.example\.test\/reset-password\?token=test-only&source=email/);
});

test("Brevo sends the existing escaped template with authentication and a stable retry ID", async () => {
  const requests = [];
  const provider = createBrevoApiProvider({ ...providerOptions, fetchImpl: async (url, options) => { requests.push({ url, options }); return accepted(); } });
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await provider.send(message), { success: true, providerReference: "brevo-message-1" });
  }
  for (const { url, options } of requests) {
    assert.equal(url, "https://api.brevo.com/v3/smtp/email");
    assert.equal(options.headers["api-key"], providerOptions.apiKey);
    assert.equal(options.method, "POST");
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.deepEqual(body.sender, { name: "GarantiyAid", email: providerOptions.senderEmail });
    assert.deepEqual(body.to, [{ email: message.recipient }]);
    assert.equal(body.headers.IdempotencyKey, notificationId);
    assert.doesNotMatch(body.subject, /[\r\n]/);
    assert.match(body.htmlContent, /Maria &lt;script&gt;/);
    assert.match(body.htmlContent, /&lt;img src=x&gt;/);
    assert.match(body.htmlContent, /Review password settings/);
    assert.match(body.htmlContent, /Event time: .*PHT/);
    assert.doesNotMatch(options.body, /test-secret-only|<script>|<img src=x>/);
  }
});

test("Brevo keeps reset links on the application origin and omits links for deactivated accounts", async () => {
  let body;
  const provider = createBrevoApiProvider({ ...providerOptions, fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return accepted(); } });
  for (const targetPath of [null, "/\\evil.example", "//evil.example", `/reset-password?token=${"x".repeat(43)}`]) {
    assert.equal((await provider.send({ ...message, targetPath })).success, true);
    if (targetPath === null) assert.doesNotMatch(body.htmlContent, /<a\b/);
    else if (targetPath.startsWith("/reset-password")) {
      assert.match(body.htmlContent, /Reset password/);
      assert.ok(body.htmlContent.includes(`href="${providerOptions.publicAppUrl}${targetPath}"`));
    } else {
      assert.ok(body.htmlContent.includes(`href="${providerOptions.publicAppUrl}/login"`));
      assert.doesNotMatch(body.htmlContent, /evil\.example/);
    }
  }
});

test("Brevo bounds retries and never returns response bodies or credentials in failures", async () => {
  for (const status of [400, 401, 403, 408, 429, 500, 503]) {
    const provider = createBrevoApiProvider({ ...providerOptions, fetchImpl: async () => ({ ok: false, status, json: async () => ({ message: "test-secret-only staff@example.test" }) }) });
    assert.deepEqual(await provider.send(message), { success: false, retryable: [408, 429, 500, 503].includes(status), errorCode: `BREVO_SEND_${status}` });
  }
  for (const name of ["TimeoutError", "TypeError"]) {
    const provider = createBrevoApiProvider({ ...providerOptions, fetchImpl: async () => { const error = new Error("test-secret-only"); error.name = name; throw error; } });
    assert.deepEqual(await provider.send(message), { success: false, retryable: true, errorCode: name === "TimeoutError" ? "BREVO_TIMEOUT" : "BREVO_NETWORK_ERROR" });
  }
  for (const json of [async () => null, async () => ({}), async () => ({ messageId: "x".repeat(121) }), async () => { throw new SyntaxError(); }]) {
    const provider = createBrevoApiProvider({ ...providerOptions, fetchImpl: async () => ({ ok: true, status: 201, json }) });
    assert.deepEqual(await provider.send(message), { success: false, retryable: false, errorCode: "BREVO_RESPONSE_INVALID" });
  }
  const noRequest = async () => { assert.fail("Invalid configuration must not call Brevo"); };
  assert.equal((await createBrevoApiProvider({ ...providerOptions, apiKey: "", fetchImpl: noRequest }).send(message)).errorCode, "BREVO_NOT_CONFIGURED");
  assert.equal((await createBrevoApiProvider({ ...providerOptions, fetchImpl: noRequest }).send({ ...message, recipient: "invalid\r\naddress" })).errorCode, "INVALID_EMAIL_ADDRESS");
});

function workerState(mode = "BREVO_API") {
  const notification = {
    ...message, title: message.subject, emailRecipient: message.recipient, userId: notificationId,
    notificationType: "SECURITY_PASSWORD_CHANGED", emailProviderMode: mode, createdAt: message.occurredAt,
    emailStatus: "PENDING", emailAttemptCount: 0, emailProcessingToken: null, user: { fullName: "Maria" },
  };
  const audits = [];
  const database = {
    staffNotification: {
      updateMany: async ({ where, data }) => {
        if (notification.emailStatus !== where.emailStatus) return { count: 0 };
        if (where.OR && notification.emailProcessingToken) return { count: 0 };
        if (Object.hasOwn(where, "emailProcessingToken") && notification.emailProcessingToken !== where.emailProcessingToken) return { count: 0 };
        for (const [key, value] of Object.entries(data)) notification[key] = key === "emailAttemptCount" ? notification[key] + value.increment : value;
        return { count: 1 };
      },
      findUnique: async () => ({ ...notification }),
    },
    auditLog: { create: async ({ data }) => audits.push(data) },
    $transaction: async (work) => work(database),
  };
  return { notification, database, audits, job: { data: { notificationId }, attemptsMade: 0, opts: { attempts: 3 } } };
}

test("worker routes persisted Gmail and Brevo jobs to their own providers without resending", async (t) => {
  const brevo = t.mock.method(brevoApiProvider, "send", async () => ({ success: true, providerReference: "brevo-message" }));
  const gmail = t.mock.method(gmailApiProvider, "send", async () => ({ success: true, providerReference: "gmail-message" }));
  for (const mode of ["GMAIL_API", "BREVO_API"]) {
    const state = workerState(mode);
    assert.equal((await processStaffEmailJob(state.job, { database: state.database })).outcome, "SENT");
    assert.equal((await processStaffEmailJob(state.job, { database: state.database })).outcome, "SKIPPED");
    assert.equal(state.audits[0].details.provider, mode);
    assert.equal(state.notification.emailProviderReference, mode === "BREVO_API" ? "brevo-message" : "gmail-message");
  }
  assert.equal(brevo.mock.callCount(), 1);
  assert.equal(gmail.mock.callCount(), 1);
  const disabled = workerState("DISABLED");
  assert.equal((await processStaffEmailJob(disabled.job, { database: disabled.database })).errorCode, "EMAIL_PROVIDER_UNAVAILABLE");
});

test("worker releases retry locks, stops at the attempt limit, and rejects missing reset links", async () => {
  const state = workerState();
  const provider = createBrevoApiProvider({ ...providerOptions, fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
  await assert.rejects(processStaffEmailJob(state.job, { database: state.database, provider }), RetryableStaffEmailError);
  assert.equal(state.notification.emailStatus, "PENDING");
  assert.equal(state.notification.emailProcessingToken, null);
  state.job.attemptsMade = 2;
  assert.equal((await processStaffEmailJob(state.job, { database: state.database, provider })).outcome, "FAILED");
  assert.equal(state.notification.emailLastErrorCode, "BREVO_SEND_429");
  const reset = workerState();
  reset.notification.notificationType = "SECURITY_PASSWORD_RESET_REQUESTED";
  const noSend = { send: async () => assert.fail("No valid reset link") };
  assert.equal((await processStaffEmailJob(reset.job, { database: reset.database, provider: noSend })).errorCode, "PASSWORD_RESET_LINK_UNAVAILABLE");
});

test("Brevo account/security events queue normally and history excludes private delivery fields", async (t) => {
  const originalMode = env.emailProviderMode;
  t.after(() => { env.emailProviderMode = originalMode; });
  env.emailProviderMode = "BREVO_API";
  assert.deepEqual(emailDeliveryConfiguration(), { configured: true, provider: "BREVO_API" });
  const database = { staffNotification: { upsert: async ({ create }) => ({ ...create, notificationId, createdAt: message.occurredAt, emailProviderReference: "private-reference", emailProcessingToken: "private-lock" }) } };
  for (const event of ["ACCOUNT_CREATED", "PASSWORD_CHANGED", "PASSWORD_RESET_REQUESTED", "PASSWORD_RESET_COMPLETED", "AUTHENTICATOR_ENABLED", "AUTHENTICATOR_REPLACED", "AUTHENTICATOR_RESET", "ACCOUNT_DEACTIVATED", "ACCOUNT_REACTIVATED"]) {
    const notification = await createStaffSecurityNotification({ event, user: { userId: notificationId, email: message.recipient, employeeId: "TEST-001" } }, database);
    assert.equal(notification.emailStatus, "PENDING");
    assert.equal(notification.emailProviderMode, "BREVO_API");
    const response = staffNotificationToResponse(notification);
    assert.equal(response.emailDelivery.configured, true);
    assert.equal(response.emailDelivery.provider, "BREVO_API");
    assert.doesNotMatch(JSON.stringify(response), /staff@example|private-reference|private-lock/);
  }
});

test("Brevo config requires credentials and a production HTTPS application URL", async () => {
  const testEnvironment = {
    NODE_ENV: "development", EMAIL_PROVIDER_MODE: "BREVO_API",
    BREVO_API_KEY: "test-secret-only", BREVO_SENDER_EMAIL: "sender@example.test", PUBLIC_APP_URL: "http://localhost:5173",
  };
  let checkNumber = 0;
  const check = async (overrides) => {
    const changes = { ...testEnvironment, ...overrides };
    const original = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, changes);
      return (await import(`../src/config/env.js?brevo-config-test=${checkNumber++}`)).env.emailProviderMode;
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
  assert.equal(await check({}), "BREVO_API");
  for (const name of ["BREVO_API_KEY", "BREVO_SENDER_EMAIL"]) {
    await assert.rejects(check({ [name]: "" }), (error) => {
      assert.ok(error.message.includes(`${name} is required`));
      assert.doesNotMatch(error.message, /test-secret-only/);
      return true;
    });
  }
  await assert.rejects(check({ PUBLIC_APP_URL: "javascript:alert(1)" }), /PUBLIC_APP_URL/);
  await assert.rejects(check({ NODE_ENV: "production" }), /PUBLIC_APP_URL: The production public application URL must use HTTPS/);
});
