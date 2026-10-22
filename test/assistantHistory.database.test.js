import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import prisma from '../src/lib/prisma.js';
import app from '../src/app.js';
import { signAccessToken } from '../src/modules/auth/auth.service.js';
import { HISTORY_RETENTION_MS, listAssistantConversations, getAssistantConversation, saveAssistantConversation, actOnAssistantConversation, purgeExpiredAssistantConversations } from '../src/modules/chatbot/assistantHistory.service.js';

// Opt in against the local development database; every write belongs to temporary test users.
const enabled = process.env.ASSISTANT_HISTORY_DB_TEST === '1';
const users = [], sessionIds = [];
let server, origin;
test.before(async () => {
  if (!enabled) return;
  for (const role of ['SYSTEM_ADMIN', 'DSWD_STAFF', 'BARANGAY_FACILITATOR']) {
    const id = randomUUID();
    users.push(await prisma.user.create({ data: { userId: id, employeeId: `history-${id.slice(0, 20)}`, username: role === 'DSWD_STAFF' ? null : `history.${id.replaceAll('-', '').slice(0, 20)}`, fullName: 'Temporary history verification', email: `${id}@example.invalid`, passwordHash: 'not-a-login-credential', role, mustChangePassword: false } }));
    const sessionId = randomUUID(); sessionIds.push(sessionId);
    await prisma.staffSession.create({ data: { sessionId, userId: id, expiresAt: new Date(Date.now() + 3600000) } });
  }
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}/api/v1/chatbot/staff-assistant/conversations`;
});
test.after(async () => {
  if (!enabled) return;
  if (server) await new Promise(resolve => server.close(resolve));
  await prisma.user.deleteMany({ where: { userId: { in: users.map(user => user.userId) } } });
  await prisma.$disconnect();
});
const body = (revision = 0, text = 'History verification question') => ({ revision, mutationId: randomUUID(), messages: [{ role: 'user', content: text, local: false }], input: '', language: 'ceb', unfinished: false });
const absent = { statusCode: 404 };

test('database: full transcript, idempotent retries, pagination and append-only revision checks', { skip: !enabled }, async () => {
  const id = randomUUID(), first = body();
  let result = await saveAssistantConversation(users[0], id, first, true);
  assert.equal((await saveAssistantConversation(users[0], id, first, true)).conversation.revision, 1);
  for (let i = 0; i < 6; i++) {
    const next = { ...body(result.conversation.revision), input: 'Preserve my draft', unfinished: true, messages: Array.from({ length: 20 }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', content: `Batch ${i} message ${n}`, local: true })) };
    result = await saveAssistantConversation(users[0], id, next);
  }
  const page1 = await getAssistantConversation(users[0], id, {}), page2 = await getAssistantConversation(users[0], id, { offset: page1.nextOffset });
  assert.equal(page1.messages.length, 100); assert.equal(page2.messages.length, 21); assert.equal(page2.nextOffset, null);
  assert.equal(page1.conversation.input, 'Preserve my draft'); assert.equal(page1.conversation.unfinished, true);
  const revision = result.conversation.revision;
  const raced = await Promise.allSettled([saveAssistantConversation(users[0], id, body(revision, 'Tab one')), saveAssistantConversation(users[0], id, body(revision, 'Tab two'))]);
  assert.equal(raced.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(raced.find(row => row.status === 'rejected').reason.statusCode, 409);
  assert.equal(await prisma.staffAssistantMessage.count({ where: { conversationId: id } }), 122);
});

test('database: owner, role and barangay boundaries protect list/read/write/archive/delete', { skip: !enabled }, async () => {
  const id = randomUUID(); await saveAssistantConversation(users[0], id, body(), true);
  for (const other of [users[1], { ...users[0], role: 'DSWD_STAFF' }, { ...users[0], barangayId: randomUUID() }]) {
    assert.equal((await listAssistantConversations(other, {})).conversations.some(row => row.id === id), false);
    await assert.rejects(getAssistantConversation(other, id, {}), absent);
    await assert.rejects(saveAssistantConversation(other, id, body(1)), absent);
    for (const action of ['touch', 'archive', 'restore', 'delete']) await assert.rejects(actOnAssistantConversation(other, id, { action, revision: 1 }), absent);
  }
});

test('database: a guided chat keeps its first user title across saves and later reloads', { skip: !enabled }, async () => {
  const id = randomUUID();
  const opening = { ...body(), messages: [{ role: 'assistant', content: 'Which program would you like to prepare?', local: true }] };
  await saveAssistantConversation(users[0], id, opening, true);
  const firstReply = await saveAssistantConversation(users[0], id, body(1, 'Prepare the October assistance program'));
  assert.equal(firstReply.conversation.title, 'Prepare the October assistance program');
  const later = await saveAssistantConversation(users[0], id, body(2, 'Another question'));
  assert.equal(later.conversation.title, firstReply.conversation.title);
  assert.equal((await getAssistantConversation(users[0], id, {})).conversation.title, firstReply.conversation.title);
});

test('database: exact 30-day inactivity expiry, touch renewal, archived retention and cascading cleanup', { skip: !enabled }, async () => {
  const initial = new Date(Date.now() - HISTORY_RETENTION_MS - 1000), expiry = new Date(initial.getTime() + HISTORY_RETENTION_MS), day = 86400000;
  const archivedId = randomUUID(), usedId = randomUUID();
  await saveAssistantConversation(users[0], archivedId, body(), true, prisma, initial);
  await saveAssistantConversation(users[0], usedId, body(), true, prisma, initial);
  const archived = await actOnAssistantConversation(users[0], archivedId, { action: 'archive', revision: 1 }, prisma, new Date(initial.getTime() + 10 * day));
  assert.equal(archived.conversation.expiresAt.getTime(), expiry.getTime());
  await actOnAssistantConversation(users[0], usedId, { action: 'touch', revision: 1 }, prisma, new Date(expiry.getTime() - 1));
  await assert.rejects(getAssistantConversation(users[0], archivedId, {}, prisma, expiry), absent);
  assert.equal((await getAssistantConversation(users[0], usedId, {}, prisma, expiry)).messages.length, 1);
  await assert.rejects(actOnAssistantConversation(users[0], archivedId, { action: 'restore', revision: 2 }, prisma, expiry), absent);
  const safeCleanup = { staffAssistantConversation: { deleteMany: ({ where }) => prisma.staffAssistantConversation.deleteMany({ where: { ...where, userId: users[0].userId } }) } };
  assert.equal((await purgeExpiredAssistantConversations(safeCleanup, expiry)).count, 1);
  assert.equal(await prisma.staffAssistantMessage.count({ where: { conversationId: archivedId } }), 0);
});

test('database: archive is reversible and delete clears content, is retryable and prevents delayed recreation', { skip: !enabled }, async () => {
  const id = randomUUID(), request = body(); await saveAssistantConversation(users[0], id, request, true);
  await actOnAssistantConversation(users[0], id, { action: 'archive', revision: 1 });
  const restored = await actOnAssistantConversation(users[0], id, { action: 'restore', revision: 2 });
  assert.equal(restored.conversation.archivedAt, null);
  assert.equal((await getAssistantConversation(users[0], id, {})).messages.length, 1);
  await actOnAssistantConversation(users[0], id, { action: 'delete', revision: 3 });
  await actOnAssistantConversation(users[0], id, { action: 'delete', revision: 3 });
  await assert.rejects(saveAssistantConversation(users[0], id, request, true), absent);
  const tombstone = await prisma.staffAssistantConversation.findUnique({ where: { id } });
  assert.equal(tombstone.input, ''); assert.equal(tombstone.title, 'Deleted conversation');
  assert.equal(await prisma.staffAssistantMessage.count({ where: { conversationId: id } }), 0);
});

test('HTTP: authenticates all staff roles, rejects operational fields and isolates account history', { skip: !enabled }, async () => {
  assert.equal((await fetch(origin)).status, 401);
  const ids = [];
  for (let n = 0; n < users.length; n++) {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${signAccessToken(users[n], { jwtId: sessionIds[n] })}` };
    const id = randomUUID(); ids.push(id);
    const invalid = await fetch(`${origin}/${id}`, { method: 'POST', headers, body: JSON.stringify({ ...body(), approvalId: randomUUID() }) });
    assert.equal(invalid.status, 400);
    const response = await fetch(`${origin}/${id}`, { method: 'POST', headers, body: JSON.stringify(body()) });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const list = await (await fetch(origin, { headers })).json();
    assert.ok(list.data.conversations.some(row => row.id === id));
    assert.ok(!list.data.conversations.some(row => ids.slice(0, -1).includes(row.id)));
    if (n) assert.equal((await fetch(`${origin}/${ids[0]}`, { headers })).status, 404);
  }
});
