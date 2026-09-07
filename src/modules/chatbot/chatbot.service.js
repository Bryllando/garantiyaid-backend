import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { env } from "../../config/env.js";
import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { generateExternalChatbotAnswer } from "./chatbot.ai.js";
import { classifyChatbotIntent } from "./chatbot.intent.js";
import {
  controlledChatbotAnswer,
  escalationReasonForIntent,
} from "./chatbot.knowledge.js";
import {
  assertChatbotReplyOwnership,
  assertChatbotSessionBarangayAccess,
  chatbotEscalationScope,
} from "./chatbot.policy.js";

const TRANSACTION_OPTIONS = Object.freeze({
  isolationLevel: "Serializable",
  maxWait: 5_000,
  timeout: 10_000,
});

const chatbotMessageCoreSelect = {
  messageId: true,
  sessionId: true,
  sequence: true,
  senderType: true,
  staffUserId: true,
  messageText: true,
  intentDetected: true,
  confidenceScore: true,
  createdAt: true,
};

export const chatbotMessagePublicSelect = {
  ...chatbotMessageCoreSelect,
  staffUser: {
    select: {
      userId: true,
      employeeId: true,
      fullName: true,
      role: true,
    },
  },
};

const chatbotSessionCoreSelect = {
  sessionId: true,
  beneficiaryId: true,
  accessTokenHash: true,
  language: true,
  status: true,
  isEscalated: true,
  escalationReason: true,
  escalatedAt: true,
  assignedStaffId: true,
  assignedAt: true,
  resolvedById: true,
  resolvedAt: true,
  resolutionCode: true,
  startedAt: true,
  endedAt: true,
  lastActivityAt: true,
  retentionUntil: true,
  createdAt: true,
  updatedAt: true,
};

export const chatbotSessionAccessSelect = {
  ...chatbotSessionCoreSelect,
  beneficiary: {
    select: {
      beneficiaryId: true,
      firstName: true,
      lastName: true,
      barangayId: true,
      barangay: {
        select: {
          barangayId: true,
          barangayName: true,
        },
      },
    },
  },
  assignedStaff: {
    select: {
      userId: true,
      employeeId: true,
      fullName: true,
      role: true,
    },
  },
  resolvedBy: {
    select: {
      userId: true,
      employeeId: true,
      fullName: true,
      role: true,
    },
  },
  _count: { select: { messages: true } },
};

export function hashChatbotSessionToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createChatbotSessionCredential() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashChatbotSessionToken(token) };
}

export function chatbotSessionTokenMatches(token, tokenHash) {
  if (typeof token !== "string" || typeof tokenHash !== "string" || !/^[a-f0-9]{64}$/i.test(tokenHash)) {
    return false;
  }
  const submitted = Buffer.from(hashChatbotSessionToken(token), "hex");
  const stored = Buffer.from(tokenHash, "hex");
  return submitted.length === stored.length && timingSafeEqual(submitted, stored);
}

export function redactChatbotText(value) {
  let redacted = value;
  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi, "[REDACTED_TOKEN]");
  redacted = redacted.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_TOKEN]");
  redacted = redacted.replace(/(?:\+?63|0)9\d{9}\b/g, "[REDACTED_CONTACT]");
  redacted = redacted.replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, "[REDACTED_IDENTIFIER]");
  redacted = redacted.replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[REDACTED_TOKEN]");
  redacted = redacted.replace(
    /\b(password|passcode|pin|otp|totp)\s*(?:is|:|=)\s*\S+/gi,
    "$1 [REDACTED_CREDENTIAL]",
  );
  return {
    messageText: redacted,
    inputRedacted: redacted !== value,
  };
}

function safeStaffIdentity(staffUser) {
  if (!staffUser) return null;
  return {
    userId: staffUser.userId,
    employeeId: staffUser.employeeId,
    fullName: staffUser.fullName,
    role: staffUser.role,
  };
}

export function chatbotMessageToResponse(message, { staffView = false } = {}) {
  return {
    messageId: message.messageId,
    sequence: message.sequence,
    senderType: message.senderType,
    messageText: message.messageText,
    intentDetected: message.intentDetected ?? null,
    confidenceScore: message.confidenceScore == null ? null : Number(message.confidenceScore),
    createdAt: message.createdAt,
    ...(staffView && message.senderType === "STAFF"
      ? { staffUser: safeStaffIdentity(message.staffUser) }
      : {}),
  };
}

export function chatbotSessionToResponse(session, { staffView = false } = {}) {
  const base = {
    sessionId: session.sessionId,
    language: session.language ?? "en",
    status: session.status,
    isEscalated: session.isEscalated,
    escalationReason: session.escalationReason ?? null,
    escalatedAt: session.escalatedAt ?? null,
    resolutionCode: session.resolutionCode ?? null,
    resolvedAt: session.resolvedAt ?? null,
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
    lastActivityAt: session.lastActivityAt,
    retentionUntil: session.retentionUntil,
    messageCount: session._count?.messages ?? undefined,
    isGeneric: !session.beneficiaryId,
    personalDataAccessEnabled: false,
  };
  if (!staffView) return base;
  return {
    ...base,
    beneficiary: session.beneficiary ? {
      beneficiaryId: session.beneficiary.beneficiaryId,
      firstName: session.beneficiary.firstName,
      lastName: session.beneficiary.lastName,
      barangayId: session.beneficiary.barangayId,
      barangayName: session.beneficiary.barangay?.barangayName ?? null,
    } : null,
    assignedStaff: safeStaffIdentity(session.assignedStaff),
    assignedAt: session.assignedAt ?? null,
    resolvedBy: safeStaffIdentity(session.resolvedBy),
  };
}

export function chatbotSessionExpired(session, now = new Date()) {
  return now.getTime() - session.startedAt.getTime() >= env.chatbotSessionMaxHours * 3_600_000;
}

function terminalSessionError(session) {
  if (session.status === "RESOLVED") {
    return new AppError(409, "CHATBOT_SESSION_RESOLVED", "This chatbot session is resolved and cannot accept new messages.");
  }
  return new AppError(409, "CHATBOT_SESSION_ENDED", "This chatbot session has ended and cannot accept new messages.");
}

export function assertChatbotSessionAcceptsMessages(session, now = new Date()) {
  if (["RESOLVED", "ENDED"].includes(session.status)) throw terminalSessionError(session);
  if (chatbotSessionExpired(session, now)) {
    throw new AppError(
      409,
      "CHATBOT_SESSION_EXPIRED",
      `Chatbot sessions accept messages for at most ${env.chatbotSessionMaxHours} hours.`,
    );
  }
}

async function getOwnedSessionOrThrow(sessionId, token, database) {
  const session = await database.chatbotSession.findUnique({
    where: { sessionId },
    select: chatbotSessionCoreSelect,
  });
  if (!session || !chatbotSessionTokenMatches(token, session.accessTokenHash)) {
    throw new AppError(404, "CHATBOT_SESSION_NOT_FOUND", "Chatbot session was not found.");
  }
  return session;
}

async function serializable(operation, database = prisma) {
  try {
    return await database.$transaction(operation, TRANSACTION_OPTIONS);
  } catch (error) {
    if (error?.code === "P2034" || error?.code === "P2002") {
      throw new AppError(
        409,
        "CHATBOT_CONCURRENT_CHANGE",
        "The chatbot session changed concurrently. Refresh the session before retrying.",
      );
    }
    throw error;
  }
}

async function expireSessionInTransaction(session, transaction, now) {
  if (!chatbotSessionExpired(session, now) || ["RESOLVED", "ENDED"].includes(session.status)) return false;
  const updated = await transaction.chatbotSession.updateMany({
    where: {
      sessionId: session.sessionId,
      status: { in: ["ACTIVE", "ESCALATED"] },
    },
    data: {
      status: "ENDED",
      endedAt: now,
      lastActivityAt: now,
    },
  });
  if (updated.count === 1) {
    await transaction.auditLog.create({
      data: {
        userId: null,
        actorType: "SYSTEM",
        action: "CHATBOT_SESSION_ENDED",
        entityAffected: "CHATBOT_SESSION",
        recordId: session.sessionId,
        details: { reasonCode: "SESSION_MAX_AGE_REACHED" },
      },
    });
  }
  return true;
}

function messageLimitError() {
  return new AppError(
    409,
    "CHATBOT_MESSAGE_LIMIT_REACHED",
    `A chatbot session may contain at most ${env.chatbotMaxMessagesPerSession} messages.`,
  );
}

async function nextMessageSequence(transaction, sessionId, additionalMessages) {
  // Interactive Prisma transactions share one PostgreSQL connection. Keep
  // these reads sequential so pg never receives overlapping client queries.
  const count = await transaction.chatbotMessage.count({ where: { sessionId } });
  const maximum = await transaction.chatbotMessage.aggregate({
    where: { sessionId },
    _max: { sequence: true },
  });
  if (count + additionalMessages > env.chatbotMaxMessagesPerSession) throw messageLimitError();
  return (maximum._max.sequence ?? 0) + 1;
}

export async function createGenericChatbotSession({ language }, database = prisma, now = new Date()) {
  const credential = createChatbotSessionCredential();
  const retentionUntil = new Date(now.getTime() + env.chatbotRetentionDays * 86_400_000);
  const session = await database.chatbotSession.create({
    data: {
      beneficiaryId: null,
      accessTokenHash: credential.tokenHash,
      language,
      status: "ACTIVE",
      isEscalated: false,
      startedAt: now,
      lastActivityAt: now,
      retentionUntil,
    },
    select: chatbotSessionCoreSelect,
  });
  return {
    session: chatbotSessionToResponse(session),
    sessionToken: credential.token,
    tokenHeader: "X-Chatbot-Session-Token",
  };
}

export async function getGenericChatbotSession(sessionId, token, database = prisma) {
  const session = await getOwnedSessionOrThrow(sessionId, token, database);
  return chatbotSessionToResponse(session);
}

export async function listGenericChatbotMessages(
  sessionId,
  token,
  { page, pageSize },
  database = prisma,
) {
  await getOwnedSessionOrThrow(sessionId, token, database);
  const [messages, total] = await Promise.all([
    database.chatbotMessage.findMany({
      where: { sessionId },
      select: chatbotMessagePublicSelect,
      orderBy: [{ sequence: "asc" }, { messageId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    database.chatbotMessage.count({ where: { sessionId } }),
  ]);
  return {
    messages: messages.map((message) => chatbotMessageToResponse(message)),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

export async function processGenericChatbotTurn(
  { sessionId, token, messageText, ipAddress },
  database = prisma,
  now = new Date(),
  externalAnswerGenerator = generateExternalChatbotAnswer,
) {
  const safeUserMessage = redactChatbotText(messageText);
  const classification = classifyChatbotIntent(safeUserMessage.messageText);
  const answerSession = await getOwnedSessionOrThrow(sessionId, token, database);
  const localizedAnswer = controlledChatbotAnswer(classification.intent, answerSession.language ?? "en");
  const externalAnswer = !chatbotSessionExpired(answerSession, now)
    && !["RESOLVED", "ENDED"].includes(answerSession.status)
    ? await externalAnswerGenerator({
      intent: classification.intent,
      language: localizedAnswer.language,
      approvedAnswer: localizedAnswer.messageText,
    })
    : null;

  const result = await serializable(async (transaction) => {
    const session = await getOwnedSessionOrThrow(sessionId, token, transaction);
    if (await expireSessionInTransaction(session, transaction, now)) return { expired: true };
    assertChatbotSessionAcceptsMessages(session, now);
    const sequence = await nextMessageSequence(transaction, sessionId, 2);
    const escalatedNow = localizedAnswer.requiresEscalation && session.status === "ACTIVE";
    const escalationReason = escalatedNow
      ? escalationReasonForIntent(classification.intent, classification.confidence)
      : session.escalationReason;

    const userMessage = await transaction.chatbotMessage.create({
      data: {
        sessionId,
        sequence,
        senderType: "USER",
        messageText: safeUserMessage.messageText,
        intentDetected: classification.intent,
        confidenceScore: classification.confidence,
      },
      select: chatbotMessageCoreSelect,
    });
    const botMessage = await transaction.chatbotMessage.create({
      data: {
        sessionId,
        sequence: sequence + 1,
        senderType: "BOT",
        messageText: externalAnswer?.messageText ?? localizedAnswer.messageText,
        intentDetected: classification.intent,
        confidenceScore: classification.confidence,
      },
      select: chatbotMessageCoreSelect,
    });

    await transaction.chatbotSession.update({
      where: { sessionId },
      data: {
        lastActivityAt: now,
        ...(escalatedNow ? {
          status: "ESCALATED",
          isEscalated: true,
          escalationReason,
          escalatedAt: now,
        } : {}),
      },
    });
    if (escalatedNow) {
      await transaction.auditLog.create({
        data: {
          userId: null,
          actorType: "SYSTEM",
          action: "CHATBOT_SESSION_ESCALATED",
          entityAffected: "CHATBOT_SESSION",
          recordId: sessionId,
          ipAddress,
          details: {
            source: "CONTROLLED_INTENT_PROCESSOR",
            reasonCode: escalationReason,
            detectedIntent: classification.intent,
            confidenceScore: classification.confidence,
            personalDataAccessed: false,
            externalAiUsed: false,
          },
        },
      });
    }

    const updatedSession = await transaction.chatbotSession.findUnique({
      where: { sessionId },
      select: chatbotSessionCoreSelect,
    });
    return {
      expired: false,
      session: updatedSession,
      userMessage,
      botMessage,
      escalatedNow,
      answer: localizedAnswer,
      externalAnswer,
    };
  }, database);

  if (result.expired) {
    throw new AppError(
      409,
      "CHATBOT_SESSION_EXPIRED",
      `Chatbot sessions accept messages for at most ${env.chatbotSessionMaxHours} hours.`,
    );
  }
  return {
    session: chatbotSessionToResponse(result.session),
    userMessage: chatbotMessageToResponse(result.userMessage),
    botMessage: chatbotMessageToResponse(result.botMessage),
    classification: {
      intent: classification.intent,
      confidenceScore: classification.confidence,
      deterministic: true,
    },
    escalatedNow: result.escalatedNow,
    inputRedacted: safeUserMessage.inputRedacted,
    personalDataAccessed: false,
    externalAiUsed: Boolean(result.externalAnswer),
    externalAiModel: result.externalAnswer?.model ?? null,
    prototypeDisclosure: result.externalAnswer
      ? "AI-assisted wording from an approved general-guidance answer; no personal records or raw user message were sent to the external model."
      : result.answer.prototypeDisclosure,
  };
}

export async function escalateGenericChatbotSession(
  { sessionId, token, reason, ipAddress },
  database = prisma,
  now = new Date(),
) {
  const result = await serializable(async (transaction) => {
    const session = await getOwnedSessionOrThrow(sessionId, token, transaction);
    if (await expireSessionInTransaction(session, transaction, now)) return { expired: true };
    if (["RESOLVED", "ENDED"].includes(session.status)) throw terminalSessionError(session);
    if (session.status === "ESCALATED") {
      throw new AppError(409, "CHATBOT_ALREADY_ESCALATED", "This chatbot session is already escalated.");
    }
    await transaction.chatbotSession.update({
      where: { sessionId },
      data: {
        status: "ESCALATED",
        isEscalated: true,
        escalationReason: reason,
        escalatedAt: now,
        lastActivityAt: now,
      },
    });
    await transaction.auditLog.create({
      data: {
        userId: null,
        actorType: "SYSTEM",
        action: "CHATBOT_SESSION_ESCALATED",
        entityAffected: "CHATBOT_SESSION",
        recordId: sessionId,
        ipAddress,
        details: {
          source: "SESSION_USER",
          reasonCode: reason,
          personalDataAccessed: false,
        },
      },
    });
    return {
      expired: false,
      session: await transaction.chatbotSession.findUnique({
        where: { sessionId },
        select: chatbotSessionCoreSelect,
      }),
    };
  }, database);
  if (result.expired) {
    throw new AppError(409, "CHATBOT_SESSION_EXPIRED", "This chatbot session has reached its maximum active duration.");
  }
  return { session: chatbotSessionToResponse(result.session), escalatedNow: true };
}

export async function endGenericChatbotSession(
  { sessionId, token, ipAddress },
  database = prisma,
  now = new Date(),
) {
  return serializable(async (transaction) => {
    const session = await getOwnedSessionOrThrow(sessionId, token, transaction);
    if (["RESOLVED", "ENDED"].includes(session.status)) throw terminalSessionError(session);
    await transaction.chatbotSession.update({
      where: { sessionId },
      data: { status: "ENDED", endedAt: now, lastActivityAt: now },
    });
    await transaction.auditLog.create({
      data: {
        userId: null,
        actorType: "SYSTEM",
        action: "CHATBOT_SESSION_ENDED",
        entityAffected: "CHATBOT_SESSION",
        recordId: sessionId,
        ipAddress,
        details: { source: "SESSION_USER" },
      },
    });
    const updated = await transaction.chatbotSession.findUnique({
      where: { sessionId },
      select: chatbotSessionCoreSelect,
    });
    return { session: chatbotSessionToResponse(updated) };
  }, database);
}

export function buildChatbotEscalationWhere(staffUser, filters) {
  return {
    status: filters.status,
    ...chatbotEscalationScope(staffUser, filters.barangayId),
    ...(filters.assignedToMe ? { assignedStaffId: staffUser.userId } : {}),
  };
}

export async function listStaffChatbotEscalations(staffUser, filters, database = prisma) {
  const { page, pageSize } = filters;
  const where = buildChatbotEscalationWhere(staffUser, filters);
  const [sessions, total] = await Promise.all([
    database.chatbotSession.findMany({
      where,
      select: chatbotSessionAccessSelect,
      orderBy: [{ lastActivityAt: "desc" }, { sessionId: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    database.chatbotSession.count({ where }),
  ]);
  return {
    escalations: sessions.map((session) => chatbotSessionToResponse(session, { staffView: true })),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

async function hydrateSessionBeneficiary(session, database) {
  if (!session.beneficiaryId) return { ...session, beneficiary: null };
  const beneficiary = await database.beneficiary.findUnique({
    where: { beneficiaryId: session.beneficiaryId },
    select: {
      beneficiaryId: true,
      firstName: true,
      lastName: true,
      barangayId: true,
    },
  });
  return { ...session, beneficiary };
}

async function getStaffSessionForMutationOrThrow(sessionId, staffUser, database) {
  const session = await database.chatbotSession.findUnique({
    where: { sessionId },
    select: chatbotSessionCoreSelect,
  });
  if (!session || !["ESCALATED", "RESOLVED"].includes(session.status)) {
    throw new AppError(404, "CHATBOT_ESCALATION_NOT_FOUND", "Chatbot escalation was not found.");
  }
  const scopedSession = await hydrateSessionBeneficiary(session, database);
  assertChatbotSessionBarangayAccess(staffUser, scopedSession);
  return scopedSession;
}

export async function getStaffChatbotEscalation(sessionId, staffUser, database = prisma) {
  const session = await database.chatbotSession.findUnique({
    where: { sessionId },
    select: chatbotSessionAccessSelect,
  });
  if (!session || !["ESCALATED", "RESOLVED"].includes(session.status)) {
    throw new AppError(404, "CHATBOT_ESCALATION_NOT_FOUND", "Chatbot escalation was not found.");
  }
  assertChatbotSessionBarangayAccess(staffUser, session);
  const messages = await database.chatbotMessage.findMany({
    where: { sessionId },
    select: chatbotMessagePublicSelect,
    orderBy: [{ sequence: "asc" }, { messageId: "asc" }],
    take: env.chatbotMaxMessagesPerSession,
  });
  return {
    session: chatbotSessionToResponse(session, { staffView: true }),
    messages: messages.map((message) => chatbotMessageToResponse(message, { staffView: true })),
  };
}

export async function createStaffChatbotReply(
  { sessionId, staffUser, messageText, ipAddress },
  database = prisma,
  now = new Date(),
) {
  const safeReply = redactChatbotText(messageText);
  return serializable(async (transaction) => {
    const session = await getStaffSessionForMutationOrThrow(sessionId, staffUser, transaction);
    assertChatbotReplyOwnership(staffUser, session);
    const sequence = await nextMessageSequence(transaction, sessionId, 1);
    await transaction.chatbotSession.update({
      where: { sessionId },
      data: {
        assignedStaffId: staffUser.userId,
        assignedAt: session.assignedAt ?? now,
        lastActivityAt: now,
      },
    });
    const message = await transaction.chatbotMessage.create({
      data: {
        sessionId,
        sequence,
        senderType: "STAFF",
        staffUserId: staffUser.userId,
        messageText: safeReply.messageText,
      },
      select: chatbotMessageCoreSelect,
    });
    await transaction.auditLog.create({
      data: {
        userId: staffUser.userId,
        actorType: "STAFF",
        action: "CHATBOT_STAFF_REPLIED",
        entityAffected: "CHATBOT_SESSION",
        recordId: sessionId,
        ipAddress,
        details: {
          responseSequence: sequence,
          assignedOnReply: !session.assignedStaffId,
          contentStored: true,
          contentIncludedInAudit: false,
        },
      },
    });
    const updated = await transaction.chatbotSession.findUnique({
      where: { sessionId },
      select: chatbotSessionCoreSelect,
    });
    return {
      session: chatbotSessionToResponse({
        ...updated,
        beneficiary: session.beneficiary,
        assignedStaff: staffUser,
        resolvedBy: null,
      }, { staffView: true }),
      message: chatbotMessageToResponse({ ...message, staffUser }, { staffView: true }),
      inputRedacted: safeReply.inputRedacted,
    };
  }, database);
}

export async function resolveStaffChatbotEscalation(
  { sessionId, staffUser, resolutionCode, ipAddress },
  database = prisma,
  now = new Date(),
) {
  return serializable(async (transaction) => {
    const session = await getStaffSessionForMutationOrThrow(sessionId, staffUser, transaction);
    assertChatbotReplyOwnership(staffUser, session);
    const transition = await transaction.chatbotSession.updateMany({
      where: {
        sessionId,
        status: "ESCALATED",
        OR: [
          { assignedStaffId: null },
          { assignedStaffId: staffUser.userId },
        ],
      },
      data: {
        status: "RESOLVED",
        assignedStaffId: staffUser.userId,
        assignedAt: session.assignedAt ?? now,
        resolvedById: staffUser.userId,
        resolvedAt: now,
        resolutionCode,
        endedAt: now,
        lastActivityAt: now,
      },
    });
    if (transition.count !== 1) {
      throw new AppError(409, "CHATBOT_CONCURRENT_CHANGE", "The escalation changed concurrently.");
    }
    await transaction.auditLog.create({
      data: {
        userId: staffUser.userId,
        actorType: "STAFF",
        action: "CHATBOT_SESSION_RESOLVED",
        entityAffected: "CHATBOT_SESSION",
        recordId: sessionId,
        ipAddress,
        details: {
          resolutionCode,
          conversationIncludedInAudit: false,
        },
      },
    });
    const updated = await transaction.chatbotSession.findUnique({
      where: { sessionId },
      select: chatbotSessionCoreSelect,
    });
    return {
      session: chatbotSessionToResponse({
        ...updated,
        beneficiary: session.beneficiary,
        assignedStaff: staffUser,
        resolvedBy: staffUser,
      }, { staffView: true }),
    };
  }, database);
}

export function chatbotRetentionDeletionWhere(now = new Date()) {
  return {
    status: { in: ["RESOLVED", "ENDED"] },
    retentionUntil: { lte: now },
  };
}
