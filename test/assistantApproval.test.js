import test from "node:test";
import assert from "node:assert/strict";
import { prepareAssistantApproval, executeAssistantApproval } from "../src/utils/assistantApproval.js";
import { confirmAssistantDistributionSchema, createDistributionSchema } from "../src/modules/distributions/distribution.schemas.js";
import { assistantReminderPreviewSchema, assistantReminderEnqueueSchema } from "../src/modules/notifications/notification.schemas.js";
import { idempotencyRequestHash } from "../src/utils/idempotency.js";

const now = new Date("2099-01-01T00:00:00Z");
const operation = "ASSISTANT_DISTRIBUTION_DRAFT";
const payload = { title: "Reviewed draft", date: new Date("2099-02-01T00:00:00Z") };
// Transaction double verifies the approval protocol, not PostgreSQL isolation.
function database() {
  let state = { records: {}, writes: 0 };
  let tail = Promise.resolve();
  const key = ({ userId, operation, idempotencyKey }) => `${userId}:${operation}:${idempotencyKey}`;
  const db = {
    get state() { return state; },
    idempotencyRecord: {
      create: async ({ data }) => {
        assert.ok(data.responseStatus >= 200 && data.responseStatus <= 599, "Match PostgreSQL response_status constraint");
        state.records[key(data)] = structuredClone(data);
      },
      findUnique: async ({ where }) => structuredClone(state.records[key(where.userId_operation_idempotencyKey)] ?? null),
      update: async ({ where, data }) => Object.assign(state.records[key(where.userId_operation_idempotencyKey)], structuredClone(data)),
    },
    $transaction(callback, options) {
      assert.equal(options.isolationLevel, "Serializable");
      const result = tail.then(async () => {
        const before = structuredClone(state);
        try { return await callback(db); }
        catch (error) { state = before; throw error; }
      });
      tail = result.catch(() => {});
      return result;
    },
  };
  return db;
}
const request = (approvalId, userId = "staff-a") => ({ auth: { userId }, validatedBody: { approvalId, confirmed: true }, get: () => approvalId });
const write = async (tx) => {
  tx.state.writes += 1;
  return { responseStatus: 201, responseBody: { success: true, data: { distribution: { distributionId: "created-once" } } } };
};

test("approval binds actor, operation, payload, explicit confirmation and header key", async () => {
  const db = database();
  const approval = await prepareAssistantApproval("staff-a", operation, payload, { checked: true }, db, now);
  assert.equal(approval.approvalExpiresAt, "2099-01-01T00:15:00.000Z");
  const req = request(approval.approvalId);
  const execute = (candidate = req, action = operation, body = payload) => executeAssistantApproval(candidate, action, body, write, db, now);
  await assert.rejects(execute(request(approval.approvalId, "staff-b")), { code: "ASSISTANT_APPROVAL_EXPIRED" });
  await assert.rejects(execute(req, "ASSISTANT_REMINDER:event"), { code: "ASSISTANT_APPROVAL_EXPIRED" });
  await assert.rejects(execute(req, operation, { ...payload, title: "Changed" }), { code: "ASSISTANT_PREVIEW_CHANGED" });
  await assert.rejects(execute({ ...req, validatedBody: { ...req.validatedBody, confirmed: false } }), { code: "ASSISTANT_CONFIRMATION_REQUIRED" });
  await assert.rejects(execute({ ...req, get: () => null }), { code: "IDEMPOTENCY_KEY_REQUIRED" });
  await assert.rejects(execute({ ...req, get: () => "11111111-1111-4111-8111-111111111111" }), { code: "ASSISTANT_APPROVAL_KEY_MISMATCH" });
  assert.equal(db.state.writes, 0);
});

test("simultaneous/repeated confirmations return the same result with one business write", async () => {
  const db = database();
  const { approvalId } = await prepareAssistantApproval("staff-a", operation, payload, {}, db, now);
  const execute = (at = now) => executeAssistantApproval(request(approvalId), operation, payload, write, db, at);
  const [first, second] = await Promise.all([execute(), execute()]);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(first.responseBody, second.responseBody);
  assert.equal(first.responseBody.data.approvalId, approvalId);
  // A lost response remains recoverable after the preview's 15-minute deadline.
  assert.equal((await execute(new Date(now.getTime() + 16 * 60_000))).replayed, true);
  assert.equal(db.state.writes, 1);
});

test("expired/unavailable approvals cannot execute or be reconstructed", async () => {
  const db = database();
  const { approvalId } = await prepareAssistantApproval("staff-a", operation, payload, {}, db, now);
  await assert.rejects(executeAssistantApproval(request(approvalId), operation, payload, write, db, new Date(now.getTime() + 15 * 60_000)), { code: "ASSISTANT_APPROVAL_EXPIRED" });
  db.state.records = {};
  await assert.rejects(executeAssistantApproval(request(approvalId), operation, payload, write, db, now), { code: "ASSISTANT_APPROVAL_EXPIRED" });
  assert.equal(db.state.writes, 0);
});

test("failed business validation or result persistence rolls back and leaves approval retryable", async () => {
  const db = database();
  const { approvalId } = await prepareAssistantApproval("staff-a", operation, payload, { recipientCount: 2 }, db, now);
  await assert.rejects(executeAssistantApproval(request(approvalId), operation, payload, async (tx, preview) => {
    assert.equal(preview.recipientCount, 2);
    await write(tx);
    throw new Error("Audit write failed");
  }, db, now), /Audit write failed/);
  assert.equal(db.state.writes, 0);
  const update = db.idempotencyRecord.update;
  db.idempotencyRecord.update = async () => { throw new Error("Result write failed"); };
  await assert.rejects(executeAssistantApproval(request(approvalId), operation, payload, write, db, now), /Result write failed/);
  assert.equal(db.state.writes, 0);
  db.idempotencyRecord.update = update;
  assert.equal((await executeAssistantApproval(request(approvalId), operation, payload, write, db, now)).replayed, false);
  assert.equal(db.state.writes, 1);
});

test("database serialization conflicts request retry using the original approval", async () => {
  const req = request("11111111-1111-4111-8111-111111111111");
  for (const code of ["P2034", "P2002"]) {
    await assert.rejects(executeAssistantApproval(req, operation, payload, write, {
      $transaction: async () => { throw Object.assign(new Error("Concurrent write"), { code }); },
    }, now), { code: "ASSISTANT_CONCURRENT_CHANGE", statusCode: 409 });
  }
});

test("preview and confirmation schemas normalize to identical payloads; approval and true confirmation are mandatory", () => {
  const approvalId = "11111111-1111-4111-8111-111111111111";
  const draft = { programId: approvalId, barangayId: approvalId, title: " Draft ", location: " Hall ", distributionDate: "2099-02-01", startTime: "09:00", endTime: "10:00", slotDurationMinutes: "30" };
  const { confirmed, approvalId: parsedId, ...confirmedDraft } = confirmAssistantDistributionSchema.parse({ ...draft, approvalId, confirmed: true });
  assert.equal(confirmed, true);
  assert.equal(parsedId, approvalId);
  assert.equal(idempotencyRequestHash(confirmedDraft), idempotencyRequestHash(createDistributionSchema.parse(draft)));
  const reminder = { messageTemplate: " Please bring your QR credential. ", serviceArea: " Purok 1 ", sendAt: "2099-02-01T09:00:00+08:00" };
  const expected = { expectedRecipientCount: 1, expectedPreviewHash: "a".repeat(64) };
  const { approvalId: reminderId, confirmed: reminderConfirmed, ...confirmedReminder } = assistantReminderEnqueueSchema.parse({ ...reminder, ...expected, approvalId, confirmed: true });
  assert.equal(reminderId, approvalId);
  assert.equal(reminderConfirmed, true);
  assert.equal(idempotencyRequestHash(confirmedReminder), idempotencyRequestHash({ ...assistantReminderPreviewSchema.parse(reminder), ...expected }));
  for (const [schema, fields] of [[confirmAssistantDistributionSchema, draft], [assistantReminderEnqueueSchema, { ...reminder, ...expected }]]) {
    assert.equal(schema.safeParse({ ...fields, confirmed: true }).success, false);
    assert.equal(schema.safeParse({ ...fields, approvalId, confirmed: false }).success, false);
    assert.equal(schema.safeParse({ ...fields, approvalId, confirmed: true, extraCommand: "execute" }).success, false);
  }
});
