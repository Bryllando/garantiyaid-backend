import prisma from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { redactChatbotText, chatbotSessionExpired } from "../chatbot/chatbot.service.js";
import { lockMobileSession } from "./mobile.service.js";

const SOURCE = "MOBILE_SUPPORT_REQUEST";
const messageSelect = { messageId: true, senderType: true, sequence: true, messageText: true, createdAt: true };
const requestSelect = { sessionId: true, language: true, status: true, startedAt: true, lastActivityAt: true,
  resolvedAt: true, resolutionCode: true, retentionUntil: true, _count: { select: { messages: true } } };
function ownerScope(session) {
  return { beneficiaryId: session.account.beneficiaryId, accessTokenHash: null,
    retentionUntil: { gt: new Date() }, messages: { some: { senderType: "USER", intentDetected: SOURCE } } };
}
function requestDto(record) {
  return { id: record.sessionId, language: record.language === "ceb" ? "bs" : record.language, status: record.status.toLowerCase(),
    createdAt: record.startedAt.toISOString(), updatedAt: record.lastActivityAt.toISOString(),
    resolvedAt: record.resolvedAt?.toISOString() ?? null, resolutionCode: record.resolutionCode?.toLowerCase() ?? null,
    retentionUntil: record.retentionUntil.toISOString(),
    canReply: record.status === "ESCALATED" && !chatbotSessionExpired(record) && record._count.messages < env.chatbotMaxMessagesPerSession };
}
function messageDto(message) {
  return { id: message.messageId, role: message.senderType === "STAFF" ? "staff" : message.senderType === "USER" ? "user" : "assistant",
    text: message.messageText, createdAt: message.createdAt.toISOString() };
}
async function ownedRequest(database, session, requestId) {
  const request = await database.chatbotSession.findFirst({ where: { sessionId: requestId, ...ownerScope(session) }, select: requestSelect });
  if (!request) throw new AppError(404, "SUPPORT_REQUEST_NOT_FOUND", "Support request not found.");
  return request;
}
async function readThread(database, session, requestId) {
  const request = await ownedRequest(database, session, requestId);
  const messages = await database.chatbotMessage.findMany({ where: { sessionId: requestId }, select: messageSelect,
    orderBy: [{ sequence: "asc" }, { messageId: "asc" }], take: 500 }); // Existing chatbot maximum is 500.
  return { request: requestDto(request), messages: messages.map(messageDto) };
}
export function getMobileSupportRequest(session, requestId) {
  return prisma.$transaction(tx => readThread(tx, session, requestId), { isolationLevel: "RepeatableRead" });
}
export function listMobileSupportRequests(session, { page, pageSize }) {
  return prisma.$transaction(async tx => {
    const where = ownerScope(session);
    const total = await tx.chatbotSession.count({ where });
    const rows = await tx.chatbotSession.findMany({ where, select: { ...requestSelect,
      messages: { where: { intentDetected: SOURCE, senderType: "USER" }, select: { messageText: true }, orderBy: { sequence: "asc" }, take: 1 } },
      orderBy: [{ lastActivityAt: "desc" }, { sessionId: "desc" }], skip: (page - 1) * pageSize, take: pageSize });
    return { requests: rows.map(row => ({ ...requestDto(row), subject: row.messages[0].messageText })),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  }, { isolationLevel: "RepeatableRead" });
}
async function mutate(session, change) {
  try {
    return await prisma.$transaction(async tx => {
      await lockMobileSession(tx, session);
      return change(tx);
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (["P2034", "P2002"].includes(error.code)) throw new AppError(409, "SUPPORT_CONCURRENT_CHANGE", "The request changed. Refresh before retrying.");
    throw error;
  }
}
async function audit(tx, session, requestId, action) {
  await tx.auditLog.create({ data: { actorType: "BENEFICIARY", action, entityAffected: "CHATBOT_SESSION", recordId: requestId,
    details: { source: SOURCE, beneficiaryId: session.account.beneficiaryId, contentIncludedInAudit: false, externalAiUsed: false } } });
}
export function createMobileSupportRequest(session, { requestId, language, messageText }) {
  const safe = redactChatbotText(messageText).messageText;
  return mutate(session, async tx => {
    const existing = await tx.chatbotSession.findUnique({ where: { sessionId: requestId }, select: { beneficiaryId: true, language: true, accessTokenHash: true,
      messages: { where: { sequence: 1 }, select: { messageText: true, intentDetected: true, senderType: true }, take: 1 } } });
    if (existing) {
      const original = existing.messages[0];
      if (existing.beneficiaryId !== session.account.beneficiaryId || existing.accessTokenHash !== null || existing.language !== language
        || original?.senderType !== "USER" || original.intentDetected !== SOURCE || original.messageText !== safe) {
        throw new AppError(409, "SUPPORT_REQUEST_CONFLICT", "Refresh your requests before sending again.");
      }
      return readThread(tx, session, requestId);
    }
    const now = new Date();
    await tx.chatbotSession.create({ data: { sessionId: requestId, beneficiaryId: session.account.beneficiaryId, accessTokenHash: null,
      language, status: "ESCALATED", isEscalated: true, escalationReason: "HUMAN_REQUESTED", escalatedAt: now,
      startedAt: now, lastActivityAt: now, retentionUntil: new Date(now.getTime() + env.chatbotRetentionDays * 86_400_000),
      messages: { create: { sequence: 1, senderType: "USER", messageText: safe, intentDetected: SOURCE } } } });
    await audit(tx, session, requestId, "MOBILE_SUPPORT_REQUEST_CREATED");
    return readThread(tx, session, requestId);
  });
}
export function replyMobileSupportRequest(session, requestId, { messageId, messageText }) {
  const safe = redactChatbotText(messageText).messageText;
  return mutate(session, async tx => {
    const request = await ownedRequest(tx, session, requestId);
    const replay = await tx.chatbotMessage.findUnique({ where: { messageId }, select: { sessionId: true, senderType: true, messageText: true } });
    if (replay) {
      if (replay.sessionId !== requestId || replay.senderType !== "USER" || replay.messageText !== safe) {
        throw new AppError(409, "SUPPORT_MESSAGE_CONFLICT", "Refresh the conversation before sending again.");
      }
      return readThread(tx, session, requestId);
    }
    if (!requestDto(request).canReply) throw new AppError(409, "SUPPORT_REQUEST_CLOSED", "This request cannot accept replies. Refresh or create a new request.");
    const maximum = await tx.chatbotMessage.aggregate({ where: { sessionId: requestId }, _max: { sequence: true } });
    await tx.chatbotMessage.create({ data: { messageId, sessionId: requestId, sequence: (maximum._max.sequence ?? 0) + 1,
      senderType: "USER", messageText: safe } });
    await tx.chatbotSession.update({ where: { sessionId: requestId }, data: { lastActivityAt: new Date() } });
    await audit(tx, session, requestId, "MOBILE_SUPPORT_MESSAGE_CREATED");
    return readThread(tx, session, requestId);
  });
}
