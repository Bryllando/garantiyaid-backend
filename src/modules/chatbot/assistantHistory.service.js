import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";

export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const scope = (user) => ({ userId: user.userId, role: user.role, barangayId: user.barangayId ?? null });
const available = (user, now) => ({ ...scope(user), deletedAt: null, expiresAt: { gt: now } });
const missing = () => new AppError(404, "CONVERSATION_UNAVAILABLE", "This conversation was deleted or expired after 30 days without use.");
const conflict = () => new AppError(409, "CONVERSATION_CHANGED", "This conversation changed in another window. Your unsaved text is still here; save a separate copy to keep it.");
const metadata = (row) => {
  const { userId, role, barangayId, deletedAt, lastMutationId, ...result } = row;
  return result;
};

export async function listAssistantConversations(user, { offset = 0 }, db = prisma, now = new Date()) {
  const rows = await db.staffAssistantConversation.findMany({
    where: available(user, now), orderBy: [{ lastUsedAt: "desc" }, { id: "asc" }], skip: offset, take: 101,
  });
  return { conversations: rows.slice(0, 100).map(metadata), nextOffset: rows.length > 100 ? offset + 100 : null };
}

export async function getAssistantConversation(user, id, { offset = 0 }, db = prisma, now = new Date()) {
  const row = await db.staffAssistantConversation.findFirst({ where: { id, ...available(user, now) } });
  if (!row) throw missing();
  const messages = await db.staffAssistantMessage.findMany({
    where: { conversationId: id, position: { gte: offset, lt: row.messageCount } },
    orderBy: { position: "asc" }, take: 100,
    select: { role: true, content: true, local: true },
  });
  if (offset < row.messageCount && !messages.length) throw conflict();
  return { conversation: metadata(row), messages, nextOffset: offset + messages.length < row.messageCount ? offset + messages.length : null };
}

// The revision prevents a stale tab overwriting another tab. Mutation IDs make a lost response safe to retry.
export async function saveAssistantConversation(user, id, body, create = false, db = prisma, now = new Date()) {
  return db.$transaction(async (tx) => {
    let row = await tx.staffAssistantConversation.findFirst({ where: { id, ...scope(user) } });
    if (row && (row.deletedAt || row.expiresAt <= now)) throw missing();
    if (row?.lastMutationId === body.mutationId) return { conversation: metadata(row) };
    if (create) {
      if (row) throw conflict();
      try {
        row = await tx.staffAssistantConversation.create({ data: {
          id, ...scope(user), lastUsedAt: now, expiresAt: new Date(now.getTime() + HISTORY_RETENTION_MS),
        } });
      } catch (error) {
        if (error.code === "P2002") throw conflict();
        throw error;
      }
    }
    if (!row) throw missing();
    if (row.revision !== body.revision || row.archivedAt) throw conflict();
    const firstUser = body.messages.find((message) => message.role === "user");
    const previousUser = firstUser && row.messageCount ? await tx.staffAssistantMessage.findFirst({
      where: { conversationId: id, role: "user" }, orderBy: { position: "asc" }, select: { content: true },
    }) : null;
    const title = (previousUser?.content || firstUser?.content || (row.messageCount === 0 ? body.messages[0]?.content || body.input || "New conversation" : row.title)).replace(/\s+/g, " ").slice(0, 90);
    const changed = await tx.staffAssistantConversation.updateMany({
      where: { id, ...available(user, now), revision: body.revision, archivedAt: null },
      data: {
        title, input: body.input, language: body.language, unfinished: body.unfinished,
        messageCount: row.messageCount + body.messages.length, revision: { increment: 1 }, lastMutationId: body.mutationId,
        lastUsedAt: now, expiresAt: new Date(now.getTime() + HISTORY_RETENTION_MS),
      },
    });
    if (!changed.count) throw conflict();
    if (body.messages.length) await tx.staffAssistantMessage.createMany({ data: body.messages.map((message, index) => ({
      ...message, conversationId: id, position: row.messageCount + index,
    })) });
    return { conversation: metadata(await tx.staffAssistantConversation.findUnique({ where: { id } })) };
  });
}

export async function actOnAssistantConversation(user, id, { action, revision }, db = prisma, now = new Date()) {
  return db.$transaction(async (tx) => {
    const where = { id, ...available(user, now) };
    const row = await tx.staffAssistantConversation.findFirst({ where: { id, ...scope(user) } });
    if (action === "delete" && row?.deletedAt) return { conversation: null };
    if (!row || row.deletedAt || row.expiresAt <= now) throw missing();
    if (action === "archive" && row.archivedAt) return { conversation: metadata(row) };
    if (action !== "touch" && row.revision !== revision) throw conflict();
    // Archiving is organization, not activity; it does not extend retention.
    const activity = { lastUsedAt: now, expiresAt: new Date(now.getTime() + HISTORY_RETENTION_MS) };
    const data = action === "touch" ? activity : {
      revision: { increment: 1 }, lastMutationId: null,
      ...(action === "archive" ? { archivedAt: now } : action === "restore" ? { archivedAt: null, ...activity } : {
        deletedAt: now, input: "", title: "Deleted conversation", unfinished: false, messageCount: 0,
      }),
    };
    const changed = await tx.staffAssistantConversation.updateMany({ where: { ...where, ...(action === "touch" ? {} : { revision }) }, data });
    if (!changed.count) throw conflict();
    // Keep only an empty tombstone until expiry so a delayed create retry cannot resurrect a deleted chat.
    if (action === "delete") await tx.staffAssistantMessage.deleteMany({ where: { conversationId: id } });
    return { conversation: action === "delete" ? null : metadata(await tx.staffAssistantConversation.findUnique({ where: { id } })) };
  });
}

export function purgeExpiredAssistantConversations(db = prisma, now = new Date()) {
  return db.staffAssistantConversation.deleteMany({ where: { expiresAt: { lte: now } } });
}

export function startAssistantHistoryCleanup() {
  let timer, stopping = false;
  async function tick() {
    try { await purgeExpiredAssistantConversations(); }
    catch (error) { console.warn({ event: "ASSISTANT_HISTORY_CLEANUP_FAILED", errorCode: error.code ?? "DATABASE_UNAVAILABLE" }); }
    finally { if (!stopping) { timer = setTimeout(() => { pending = tick(); }, 60 * 60 * 1000); timer.unref(); } }
  }
  let pending = tick();
  return async () => { stopping = true; clearTimeout(timer); await pending; };
}
