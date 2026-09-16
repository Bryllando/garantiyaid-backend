import test from "node:test";
import assert from "node:assert/strict";
import { createGmailApiProvider } from "../src/modules/staffNotifications/gmailApi.provider.js";
import { processStaffEmailJob } from "../src/workers/staffEmail.processor.js";

const notificationId = "11111111-1111-4111-8111-111111111111";

test("Gmail API delivery uses HTTPS, a safe multipart message, and retryable quota errors", async () => {
  const message = "Your password was changed. Kumusta, José! ".repeat(40) + "\nContact an administrator if this was unexpected.";
  const requests = [];
  const responses = [
    { ok: true, status: 200, json: async () => ({ access_token: "short-lived-token" }) },
    { ok: true, status: 200, json: async () => ({ id: "gmail-message-1" }) },
  ];
  const provider = createGmailApiProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    senderEmail: "garantiyaid.notifications@gmail.com",
    publicAppUrl: "https://garantiyaid.vercel.app",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return responses[requests.length - 1];
    },
  });

  const result = await provider.send({
    notificationId,
    recipient: "staff@example.com",
    recipientName: "Maria Santos",
    subject: "Password changed\r\nBcc: attacker@example.com",
    message,
    targetPath: "/account?section=password",
    occurredAt: new Date("2026-09-15T10:00:00Z"),
  });

  assert.deepEqual(result, { success: true, providerReference: "gmail-message-1" });
  assert.equal(requests[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(requests[1].url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.equal(requests[1].options.headers.Authorization, "Bearer short-lived-token");
  const raw = Buffer.from(JSON.parse(requests[1].options.body).raw, "base64url").toString("utf8");
  assert.ok(raw.split("\r\n").every((line) => Buffer.byteLength(line) <= 998));
  const dateHeader = raw.match(/^Date: (.+)\r?$/m);
  assert.ok(dateHeader && Number.isFinite(Date.parse(dateHeader[1])));
  const parts = [...raw.matchAll(/Content-Type: text\/(plain|html); charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--/g)];
  assert.deepEqual(parts.map((part) => part[1]), ["plain", "html"]);
  for (const [, type, encoded] of parts) {
    assert.ok(encoded.split("\r\n").every((line) => line.length <= 76));
    const body = Buffer.from(encoded, "base64").toString("utf8");
    assert.ok(body.includes(message.replaceAll("\n", "\r\n")));
    assert.match(body, /Review password settings/);
    assert.match(body, /Event time: .*PHT/);
    assert.match(body, /https:\/\/garantiyaid\.vercel\.app\/account\?section=password/);
    assert.doesNotMatch(body, /client-secret|refresh-token|temporary password:/i);
    if (type === "html") {
      assert.doesNotMatch(body, /display\s*:\s*none|max-height\s*:\s*0/i);
      assert.match(body, /<html lang="en">/);
      assert.match(body, /<h1\b/);
      assert.match(body, /name="viewport"/);
    }
  }
  assert.doesNotMatch(raw, /\r\nBcc:/i);
  assert.doesNotMatch(raw, /client-secret|refresh-token|temporary password:/i);

  const throttled = createGmailApiProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    senderEmail: "garantiyaid.notifications@gmail.com",
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }),
    }),
  });
  assert.deepEqual(
    await throttled.send({ notificationId, recipient: "staff@example.com", subject: "Alert", message: "Alert", targetPath: "/login" }),
    { success: false, retryable: true, errorCode: "GMAIL_TOKEN_TEMPORARY" },
  );
});

test("inactive-account emails omit sign-in actions and unsafe targets stay on the app origin", async () => {
  let raw;
  const provider = createGmailApiProvider({
    clientId: "test", clientSecret: "test", refreshToken: "test", senderEmail: "sender@example.test",
    publicAppUrl: "https://garantiyaid.vercel.app",
    fetchImpl: async (url, options) => {
      if (url.includes("/token")) return { ok: true, json: async () => ({ access_token: "test" }) };
      raw = Buffer.from(JSON.parse(options.body).raw, "base64url").toString();
      return { ok: true, json: async () => ({ id: "test" }) };
    },
  });
  for (const targetPath of [null, "/\\evil.test"]) {
    const result = await provider.send({ notificationId, recipient: "recipient@example.test", subject: "Account update", message: "Contact your administrator.", targetPath });
    assert.equal(result.success, true);
    const encoded = raw.match(/Content-Type: text\/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--/)[1];
    const body = Buffer.from(encoded, "base64").toString();
    if (targetPath === null) assert.doesNotMatch(body, /<a\b/);
    else {
      assert.match(body, /href="https:\/\/garantiyaid\.vercel\.app\/login"/);
      assert.doesNotMatch(body, /evil\.test/);
    }
  }
});

test("staff email worker claims a notification once and records the sent result", async () => {
  const state = {
    notification: {
      notificationId,
      userId: "22222222-2222-4222-8222-222222222222",
      notificationType: "SECURITY_PASSWORD_CHANGED",
      title: "Password changed",
      message: "Your password was changed.",
      targetPath: "/account?section=password",
      emailProviderMode: "GMAIL_API",
      emailRecipient: "staff@example.com",
      emailStatus: "PENDING",
      emailAttemptCount: 0,
      emailProcessingToken: null,
      emailProcessingStartedAt: null,
      user: { fullName: "Maria Santos" },
    },
    audits: [],
  };
  const database = {
    staffNotification: {
      updateMany: async ({ where, data }) => {
        if (state.notification.emailStatus !== where.emailStatus) return { count: 0 };
        if (Object.hasOwn(where, "emailProcessingToken") && state.notification.emailProcessingToken !== where.emailProcessingToken) return { count: 0 };
        if (data.emailAttemptCount) state.notification.emailAttemptCount += data.emailAttemptCount.increment;
        Object.assign(state.notification, Object.fromEntries(Object.entries(data).filter(([key]) => key !== "emailAttemptCount")));
        return { count: 1 };
      },
      findUnique: async () => ({ ...state.notification }),
    },
    auditLog: { create: async ({ data }) => { state.audits.push(data); return data } },
    $transaction: async (work) => work(database),
  };
  let sends = 0;
  const provider = { send: async () => { sends += 1; return { success: true, providerReference: "gmail-message-1" } } };
  const job = { data: { notificationId }, attemptsMade: 0, opts: { attempts: 3 } };

  assert.equal((await processStaffEmailJob(job, { database, provider })).outcome, "SENT");
  assert.equal((await processStaffEmailJob(job, { database, provider })).outcome, "SKIPPED");
  assert.equal(sends, 1);
  assert.equal(state.notification.emailStatus, "SENT");
  assert.equal(state.notification.emailAttemptCount, 1);
  assert.equal(state.audits[0].action, "STAFF_SECURITY_EMAIL_SENT");
});
