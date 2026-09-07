import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { chatbotRateLimiter } from "../../middleware/rateLimit.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
import {
  createChatbotSession,
  endChatbotSession,
  escalateChatbotSession,
  getChatbotEscalation,
  getChatbotSession,
  listChatbotEscalations,
  listChatbotMessages,
  recordStaffAssistantFeedback,
  replyToChatbotEscalation,
  resolveChatbotEscalation,
  submitStaffAssistantMessage,
  submitChatbotMessage,
} from "./chatbot.controller.js";
import { CHATBOT_STAFF_ROLES } from "./chatbot.constants.js";
import {
  chatbotEscalateSchema,
  chatbotEscalationListQuerySchema,
  chatbotMessageListQuerySchema,
  chatbotMessageSchema,
  chatbotResolveSchema,
  chatbotSessionParamsSchema,
  chatbotStaffReplySchema,
  createChatbotSessionSchema,
  endChatbotSessionSchema,
  staffAssistantFeedbackSchema,
  staffAssistantMessageSchema,
} from "./chatbot.schemas.js";

const chatbotRoutes = Router();

chatbotRoutes.post(
  "/staff-assistant/messages",
  authenticateStaff,
  authorizeRoles(...CHATBOT_STAFF_ROLES),
  chatbotRateLimiter,
  validateBody(staffAssistantMessageSchema),
  submitStaffAssistantMessage,
);

chatbotRoutes.post(
  "/staff-feedback",
  authenticateStaff,
  authorizeRoles(...CHATBOT_STAFF_ROLES),
  chatbotRateLimiter,
  validateBody(staffAssistantFeedbackSchema),
  recordStaffAssistantFeedback,
);

chatbotRoutes.post(
  "/sessions",
  chatbotRateLimiter,
  validateBody(createChatbotSessionSchema),
  createChatbotSession,
);
chatbotRoutes.get(
  "/sessions/:sessionId",
  chatbotRateLimiter,
  validateParams(chatbotSessionParamsSchema),
  getChatbotSession,
);
chatbotRoutes.get(
  "/sessions/:sessionId/messages",
  chatbotRateLimiter,
  validateParams(chatbotSessionParamsSchema),
  validateQuery(chatbotMessageListQuerySchema),
  listChatbotMessages,
);
chatbotRoutes.post(
  "/sessions/:sessionId/messages",
  chatbotRateLimiter,
  validateParams(chatbotSessionParamsSchema),
  validateBody(chatbotMessageSchema),
  submitChatbotMessage,
);
chatbotRoutes.post(
  "/sessions/:sessionId/escalate",
  chatbotRateLimiter,
  validateParams(chatbotSessionParamsSchema),
  validateBody(chatbotEscalateSchema),
  escalateChatbotSession,
);
chatbotRoutes.post(
  "/sessions/:sessionId/end",
  chatbotRateLimiter,
  validateParams(chatbotSessionParamsSchema),
  validateBody(endChatbotSessionSchema),
  endChatbotSession,
);

chatbotRoutes.get(
  "/escalations",
  authenticateStaff,
  authorizeRoles(...CHATBOT_STAFF_ROLES),
  chatbotRateLimiter,
  validateQuery(chatbotEscalationListQuerySchema),
  listChatbotEscalations,
);
chatbotRoutes.get(
  "/escalations/:sessionId",
  authenticateStaff,
  authorizeRoles(...CHATBOT_STAFF_ROLES),
  chatbotRateLimiter,
  validateParams(chatbotSessionParamsSchema),
  getChatbotEscalation,
);
chatbotRoutes.post(
  "/escalations/:sessionId/reply",
  authenticateStaff,
  authorizeRoles(...CHATBOT_STAFF_ROLES),
  chatbotRateLimiter,
  validateParams(chatbotSessionParamsSchema),
  validateBody(chatbotStaffReplySchema),
  replyToChatbotEscalation,
);
chatbotRoutes.post(
  "/escalations/:sessionId/resolve",
  authenticateStaff,
  authorizeRoles(...CHATBOT_STAFF_ROLES),
  chatbotRateLimiter,
  validateParams(chatbotSessionParamsSchema),
  validateBody(chatbotResolveSchema),
  resolveChatbotEscalation,
);

export default chatbotRoutes;
