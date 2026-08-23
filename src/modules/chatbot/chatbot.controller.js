import { clientIpAddress } from "../../utils/clientIp.js";
import { AppError } from "../../utils/AppError.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  publishChatbotSessionEscalated,
  publishChatbotSessionResolved,
  publishChatbotStaffReplyCreated,
} from "../../realtime/publishers.js";
import { CHATBOT_SESSION_TOKEN_HEADER } from "./chatbot.constants.js";
import {
  createGenericChatbotSession,
  createStaffChatbotReply,
  endGenericChatbotSession,
  escalateGenericChatbotSession,
  getGenericChatbotSession,
  getStaffChatbotEscalation,
  listGenericChatbotMessages,
  listStaffChatbotEscalations,
  processGenericChatbotTurn,
  resolveStaffChatbotEscalation,
} from "./chatbot.service.js";

function chatbotSessionToken(req) {
  const token = req.get(CHATBOT_SESSION_TOKEN_HEADER);
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new AppError(
      401,
      "CHATBOT_SESSION_TOKEN_REQUIRED",
      "A valid X-Chatbot-Session-Token header is required.",
    );
  }
  return token;
}

function eventSession(session) {
  return {
    sessionId: session.sessionId,
    status: session.status,
    barangayId: session.beneficiary?.barangayId ?? null,
  };
}

export const createChatbotSession = asyncHandler(async (req, res) => {
  const result = await createGenericChatbotSession(req.validatedBody);
  res.status(201).json({
    success: true,
    data: {
      ...result,
      genericGuidanceOnly: true,
      beneficiaryAuthenticationAvailable: false,
      warning: "Save the session token securely. It is returned only once and does not authorize personal-record access.",
    },
  });
});

export const getChatbotSession = asyncHandler(async (req, res) => {
  const session = await getGenericChatbotSession(
    req.validatedParams.sessionId,
    chatbotSessionToken(req),
  );
  res.status(200).json({ success: true, data: { session } });
});

export const listChatbotMessages = asyncHandler(async (req, res) => {
  const data = await listGenericChatbotMessages(
    req.validatedParams.sessionId,
    chatbotSessionToken(req),
    req.validatedQuery,
  );
  res.status(200).json({ success: true, data });
});

export const submitChatbotMessage = asyncHandler(async (req, res) => {
  const data = await processGenericChatbotTurn({
    sessionId: req.validatedParams.sessionId,
    token: chatbotSessionToken(req),
    messageText: req.validatedBody.messageText,
    ipAddress: clientIpAddress(req),
  });
  if (data.escalatedNow) {
    await publishChatbotSessionEscalated(eventSession(data.session), {
      reasonCode: data.session.escalationReason,
    });
  }
  res.status(201).json({ success: true, data });
});

export const escalateChatbotSession = asyncHandler(async (req, res) => {
  const data = await escalateGenericChatbotSession({
    sessionId: req.validatedParams.sessionId,
    token: chatbotSessionToken(req),
    reason: req.validatedBody.reason,
    ipAddress: clientIpAddress(req),
  });
  await publishChatbotSessionEscalated(eventSession(data.session), {
    reasonCode: data.session.escalationReason,
  });
  res.status(200).json({ success: true, data });
});

export const endChatbotSession = asyncHandler(async (req, res) => {
  const data = await endGenericChatbotSession({
    sessionId: req.validatedParams.sessionId,
    token: chatbotSessionToken(req),
    ipAddress: clientIpAddress(req),
  });
  res.status(200).json({ success: true, data });
});

export const listChatbotEscalations = asyncHandler(async (req, res) => {
  const data = await listStaffChatbotEscalations(req.staffUser, req.validatedQuery);
  res.status(200).json({ success: true, data });
});

export const getChatbotEscalation = asyncHandler(async (req, res) => {
  const data = await getStaffChatbotEscalation(
    req.validatedParams.sessionId,
    req.staffUser,
  );
  res.status(200).json({ success: true, data });
});

export const replyToChatbotEscalation = asyncHandler(async (req, res) => {
  const data = await createStaffChatbotReply({
    sessionId: req.validatedParams.sessionId,
    staffUser: req.staffUser,
    messageText: req.validatedBody.messageText,
    ipAddress: clientIpAddress(req),
  });
  await publishChatbotStaffReplyCreated(eventSession(data.session), {
    staffUserId: req.staffUser.userId,
    sequence: data.message.sequence,
  });
  res.status(201).json({ success: true, data });
});

export const resolveChatbotEscalation = asyncHandler(async (req, res) => {
  const data = await resolveStaffChatbotEscalation({
    sessionId: req.validatedParams.sessionId,
    staffUser: req.staffUser,
    resolutionCode: req.validatedBody.resolutionCode,
    ipAddress: clientIpAddress(req),
  });
  await publishChatbotSessionResolved(eventSession(data.session), {
    resolutionCode: data.session.resolutionCode,
  });
  res.status(200).json({ success: true, data });
});
