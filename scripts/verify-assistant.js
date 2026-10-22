import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";

// This executable verification uses synthetic data and a private queue on LOCAL services only.
for (const value of [process.env.DATABASE_URL, process.env.REDIS_URL || "redis://127.0.0.1:6379"]) {
  assert.ok(value && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname), "Verification requires local PostgreSQL and Redis.");
}
assert.notEqual(process.env.NODE_ENV, "production", "Verification refuses production mode.");
const cleanupRun = process.argv.find((argument) => argument.startsWith("--cleanup-run="))?.slice("--cleanup-run=".length);
if (cleanupRun) assert.match(cleanupRun, /^[a-f0-9]{8}$/, "Cleanup requires one exact verification run ID.");
const run = cleanupRun || randomUUID().slice(0, 8);
process.env.NODE_ENV = "test";
process.env.NOTIFICATION_QUEUE_NAME = `assistant-verify-${run}`;
process.env.SMS_SIMULATED_FAILURE_MODE = "NONE";
const { default: prisma } = await import("../src/lib/prisma.js");
const { default: app } = await import("../src/app.js");
const { issueAccessToken } = await import("../src/modules/auth/auth.service.js");
const { getNotificationQueue, closeNotificationQueue, notificationJobId } = await import("../src/queues/notification.queue.js");
const { processNotificationJob } = await import("../src/workers/notification.processor.js");
const { env } = await import("../src/config/env.js");
const users = [], areas = [], beneficiaries = [];
let program, server, baseUrl;
let checks = 0;
const passed = (label) => { checks++; console.log(`PASS ${label}`); };
const date = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
async function request(path, { token, body, approvalId, status = 200, code } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(approvalId ? { "idempotency-key": approvalId } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json();
  assert.equal(response.status, status, `${path}: expected ${status}, received ${response.status} (${result.error?.code || "no error code"})`);
  if (code) assert.equal(result.error?.code, code);
  return result.data;
}
const previewDraft = (body, token) => request("/distributions/assistant-preview", { body, token });
const confirmDraft = (body, approval, token, status = 201, code) => request("/distributions/assistant-confirm", { body: { ...body, approvalId: approval.approvalId, confirmed: true }, approvalId: approval.approvalId, token, status, code });
async function cleanup() {
  const queue = getNotificationQueue();
  assert.equal(queue.name, `assistant-verify-${run}`);
  await queue.obliterate({ force: true });
  await closeNotificationQueue();
  const userIds = users.map((user) => user.userId);
  const events = program ? await prisma.distribution.findMany({ where: { programId: program.programId }, select: { distributionId: true } }) : [];
  const ids = events.map((event) => event.distributionId);
  await prisma.staffNotification.deleteMany({ where: { OR: [{ userId: { in: userIds } }, ...ids.map((id) => ({ deduplicationKey: { contains: id } }))] } });
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { distributionId: { in: ids } } });
  await prisma.schedule.deleteMany({ where: { distributionId: { in: ids } } });
  await prisma.distributionSlot.deleteMany({ where: { distributionId: { in: ids } } });
  await prisma.distribution.deleteMany({ where: { distributionId: { in: ids } } });
  await prisma.beneficiary.deleteMany({ where: { beneficiaryId: { in: beneficiaries.map((row) => row.beneficiaryId) } } });
  if (program) await prisma.program.delete({ where: { programId: program.programId } });
  await prisma.idempotencyRecord.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.staffSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.barangay.deleteMany({ where: { barangayId: { in: areas.map((area) => area.barangayId) } } });
  assert.equal(await prisma.user.count({ where: { userId: { in: userIds } } }), 0);
}

try {
  await getNotificationQueue().waitUntilReady();
  console.log(`Verification run: ${run}`);
  if (cleanupRun) {
    users.push(...await prisma.user.findMany({ where: { employeeId: { startsWith: `QA-${run}-` }, fullName: { startsWith: "Assistant QA " }, email: { endsWith: "@example.invalid" } } }));
    areas.push(...await prisma.barangay.findMany({ where: { barangayCode: { in: [`${run}-0`, `${run}-1`] }, city: "Test City", province: "Test Province" } }));
    program = await prisma.program.findFirst({ where: { programCode: `QA-${run}`, createdById: { in: users.map((user) => user.userId) } } });
    beneficiaries.push(...await prisma.beneficiary.findMany({ where: { barangayId: { in: areas.map((area) => area.barangayId) }, address: "Synthetic verification record" } }));
  } else {
  for (const name of ["Assistant verification", "Other verification area"]) areas.push(await prisma.barangay.create({ data: { barangayCode: `${run}-${areas.length}`, barangayName: `${name} ${run}`, city: "Test City", province: "Test Province" } }));
  for (const role of ["SYSTEM_ADMIN", "SYSTEM_ADMIN", "DSWD_STAFF", "BARANGAY_FACILITATOR"]) {
    users.push(await prisma.user.create({ data: { employeeId: `QA-${run}-${users.length}`, username: role === "DSWD_STAFF" ? null : `qa.${run}.${users.length}`, fullName: `Assistant QA ${role}`, email: `${run}-${users.length}@example.invalid`, passwordHash: randomUUID(), mustChangePassword: false, role, ...(role === "BARANGAY_FACILITATOR" ? { barangayId: areas[0].barangayId } : {}) } }));
  }
  const [admin, otherAdmin, dswd, facilitator] = await Promise.all(users.map(async (user) => (await issueAccessToken(user)).accessToken));
  program = await prisma.program.create({ data: { programCode: `QA-${run}`, programName: `Assistant verification ${run}`, programType: "CASH", status: "ACTIVE", createdById: users[0].userId } });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  const draft = { programId: program.programId, barangayId: areas[0].barangayId, title: "Assistant API verification", location: "Test Hall", distributionDate: date, startTime: "09:00", endTime: "10:00", slotDurationMinutes: 30, verificationRequirement: "QR" };
  await request("/distributions/assistant-preview", { body: draft, status: 401 });
  for (const token of [dswd, facilitator]) await request("/distributions/assistant-preview", { body: draft, token, status: 403 });
  await request("/distributions/assistant-preview", { body: { ...draft, slotDurationMinutes: 17 }, token: admin, status: 400 });
  passed("authenticated roles and invalid configuration enforced over HTTP");
  const approval = await previewDraft(draft, admin);
  assert.equal(await prisma.distribution.count({ where: { programId: program.programId } }), 0);
  assert.equal(await prisma.notification.count({ where: { initiatedById: users[0].userId } }), 0);
  passed("preview/cancellation creates no distribution or notification");
  await confirmDraft({ ...draft, title: "Altered after review" }, approval, admin, 409, "ASSISTANT_PREVIEW_CHANGED");
  await confirmDraft(draft, approval, otherAdmin, 409, "ASSISTANT_APPROVAL_EXPIRED");
  await request("/distributions/assistant-confirm", { token: admin, body: { ...draft, ...approval, confirmed: false }, approvalId: approval.approvalId, status: 400 });
  await request("/distributions/assistant-confirm", { token: admin, body: { ...draft, approvalId: approval.approvalId, confirmed: true }, approvalId: randomUUID(), status: 409, code: "ASSISTANT_APPROVAL_KEY_MISMATCH" });
  passed("changed payload, wrong actor, false confirmation and wrong key rejected");
  const expired = await previewDraft(draft, admin);
  await prisma.idempotencyRecord.updateMany({ where: { userId: users[0].userId, idempotencyKey: expired.approvalId }, data: { responseBody: { approvalExpiresAt: new Date(0).toISOString(), preview: {} } } });
  await confirmDraft(draft, expired, admin, 409, "ASSISTANT_APPROVAL_EXPIRED");
  passed("server expiration blocks unused approval");
  const concurrent = await Promise.allSettled([confirmDraft(draft, approval, admin), confirmDraft(draft, approval, admin)]);
  assert.ok(concurrent.some((outcome) => outcome.status === "fulfilled"));
  const saved = await confirmDraft(draft, approval, admin);
  assert.equal(await prisma.distribution.count({ where: { programId: program.programId } }), 1);
  assert.equal(await prisma.auditLog.count({ where: { userId: users[0].userId, action: "DISTRIBUTION_CREATED" } }), 1);
  assert.equal(saved.distribution.status, "DRAFT");
  passed("live PostgreSQL concurrent confirmation and lost-response replay create once");
  const lateDraft = { ...draft, startTime: "11:00", endTime: "12:00" };
  const beforeConflict = await previewDraft(lateDraft, admin);
  const competing = await previewDraft(lateDraft, admin);
  await confirmDraft(lateDraft, competing, admin);
  await confirmDraft(lateDraft, beforeConflict, admin, 409, "DISTRIBUTION_TIME_CONFLICT");
  passed("new overlap after preview blocks execution");
  const deactivated = await previewDraft({ ...draft, startTime: "13:00", endTime: "14:00" }, admin);
  await prisma.program.update({ where: { programId: program.programId }, data: { status: "CLOSED" } });
  await confirmDraft({ ...draft, startTime: "13:00", endTime: "14:00" }, deactivated, admin, 409);
  await prisma.program.update({ where: { programId: program.programId }, data: { status: "ACTIVE" } });
  passed("program status is revalidated at confirmation");

  const distributionId = saved.distribution.distributionId;
  await prisma.distribution.update({ where: { distributionId }, data: { status: "OPEN" } });
  const slot = await prisma.distributionSlot.create({ data: { distributionId, sessionId: randomUUID(), sessionLabel: "Morning", location: "Test Hall", serviceAreas: ["Purok QA"], slotStart: new Date(`${date}T09:00:00+08:00`), slotEnd: new Date(`${date}T09:30:00+08:00`), capacity: 5 } });
  for (const contact of ["09171234567", "invalid"]) beneficiaries.push(await prisma.beneficiary.create({ data: { firstName: "Test", lastName: `Recipient ${beneficiaries.length + 1}`, birthDate: new Date("1990-01-01"), sex: "FEMALE", address: "Synthetic verification record", barangayId: areas[0].barangayId, sitioPurok: "Purok QA", contactNumber: contact } }));
  const schedules = [];
  for (const beneficiary of beneficiaries) schedules.push(await prisma.schedule.create({ data: { distributionId, beneficiaryId: beneficiary.beneficiaryId, slotId: slot.slotId, queueNumber: schedules.length + 1 } }));
  const reminder = { serviceArea: "Purok QA", messageTemplate: "Please bring your QR credential to {location}. Queue {queue}." };
  const reminderPath = `/distributions/${distributionId}/notifications`;
  const previewReminder = (body = reminder, token = facilitator) => request(`${reminderPath}/assistant-preview`, { body, token });
  const confirmReminder = (preview, body = reminder, status = 202, code) => request(`${reminderPath}/assistant-enqueue`, { token: facilitator, body: { ...body, approvalId: preview.approvalId, confirmed: true, expectedRecipientCount: preview.recipientCount, expectedPreviewHash: preview.previewHash }, approvalId: preview.approvalId, status, code });
  let recipientPreview = await previewReminder();
  assert.equal(recipientPreview.recipientCount, 1);
  assert.equal(recipientPreview.excluded.invalidContactCount, 1);
  await prisma.beneficiary.update({ where: { beneficiaryId: beneficiaries[0].beneficiaryId }, data: { contactNumber: "09187654321" } });
  await confirmReminder(recipientPreview, reminder, 409, "NOTIFICATION_PREVIEW_CHANGED");
  passed("invalid contacts excluded and changed valid recipient requires a fresh preview");
  recipientPreview = await previewReminder();
  await prisma.user.update({ where: { userId: users[3].userId }, data: { barangayId: areas[1].barangayId } });
  await confirmReminder(recipientPreview, reminder, 403, "FORBIDDEN");
  await prisma.user.update({ where: { userId: users[3].userId }, data: { barangayId: areas[0].barangayId } });
  passed("facilitator assignment changes reject an earlier approval");
  const past = { ...reminder, sendAt: new Date(Date.now() - 60_000).toISOString() };
  const pastPreview = await previewReminder(past);
  await confirmReminder(pastPreview, past, 409, "ASSISTANT_SCHEDULE_PASSED");
  passed("server rejects passed reminder queue time");
  for (const status of ["CANCELLED", "CLOSED"]) {
    await prisma.distribution.update({ where: { distributionId }, data: { status } });
    await confirmReminder(recipientPreview, reminder, 409, "NOTIFICATION_LIFECYCLE_INVALID");
  }
  await prisma.distribution.update({ where: { distributionId }, data: { status: "OPEN" } });
  passed("cancelled/closed events cannot execute a pending reminder approval");
  recipientPreview = await previewReminder();
  // Disconnect only this run's Redis client; the shared Redis service stays up.
  await getNotificationQueue().disconnect();
  await confirmReminder(recipientPreview, reminder, 503, "NOTIFICATION_QUEUE_UNAVAILABLE");
  assert.equal(await prisma.notification.count({ where: { distributionId } }), 1);
  await closeNotificationQueue();
  const queued = await confirmReminder(recipientPreview);
  const replay = await confirmReminder(recipientPreview);
  assert.deepEqual(queued, replay);
  assert.equal(await prisma.notification.count({ where: { distributionId } }), 1);
  const job = await getNotificationQueue().getJob(notificationJobId(queued.notifications[0].notificationId));
  assert.ok(job);
  passed("Redis disconnect after DB commit recovers the same rows and stable job");
  const outcomes = await Promise.all([processNotificationJob(job, { publishLifecycle: async () => {} }), processNotificationJob(job, { publishLifecycle: async () => {} })]);
  assert.equal(outcomes.filter((outcome) => outcome.outcome === "SENT_SIMULATED").length, 1);
  assert.equal(await prisma.notification.count({ where: { distributionId, status: "SENT" } }), 1);
  await confirmReminder(recipientPreview);
  assert.equal(await prisma.notification.count({ where: { distributionId } }), 1);
  passed("live worker concurrency sends simulated notice once; replay does not resend");
  if (process.argv.includes("--ui")) {
    const { verifyAssistantUi } = await import("../../garantiyaid-frontend/scripts/verify-assistant-ui.js");
    await verifyAssistantUi({ baseUrl, env, admin: { token: admin, user: users[0] }, facilitator: { token: facilitator, user: users[3] }, program, area: areas[0], distribution: saved.distribution, date, prisma });
    passed("browser detail collection, correction, cancellation, confirmation and recovery");
  }
  console.log(JSON.stringify({ success: true, phase: "assistant-6", checks, browser: process.argv.includes("--ui"), simulatedSmsOnly: true }));
  }
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  try { await cleanup(); console.log("CLEANUP temporary records and private queue removed"); }
  catch (error) { console.error(`CLEANUP FAILED ${error.code || error.name}`); process.exitCode = 1; }
  await prisma.$disconnect();
}
