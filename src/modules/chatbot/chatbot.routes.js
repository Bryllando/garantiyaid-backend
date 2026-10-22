import { Router } from "express";
import assistantHistoryRoutes from "./assistantHistory.routes.js";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { chatbotRateLimiter } from "../../middleware/rateLimit.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
import {
  createChatbotSession,
  endChatbotSession,
  escalateChatbotSession,
  getChatbotEscalation,
  getChatbotConversationHistory,
  getChatbotSession,
  listChatbotEscalations,
  listChatbotConversationHistory,
  listChatbotMessages,
  recordStaffAssistantFeedback,
  referChatbotEscalation,
  replyToChatbotEscalation,
  resolveChatbotEscalation,
  submitStaffAssistantMessage,
  submitChatbotMessage,
} from "./chatbot.controller.js";
import { CHATBOT_STAFF_ROLES } from "./chatbot.constants.js";
import {
  chatbotEscalateSchema,
  chatbotEscalationListQuerySchema,
  chatbotHistoryQuerySchema,
  chatbotMessageListQuerySchema,
  chatbotMessageSchema,
  chatbotResolveSchema,
  chatbotReferralSchema,
  chatbotSessionParamsSchema,
  chatbotStaffReplySchema,
  createChatbotSessionSchema,
  endChatbotSessionSchema,
  staffAssistantFeedbackSchema,
  staffAssistantMessageSchema,
} from "./chatbot.schemas.js";

const chatbotRoutes = Router();
chatbotRoutes.use("/staff-assistant/conversations", authenticateStaff, authorizeRoles(...CHATBOT_STAFF_ROLES), assistantHistoryRoutes);

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
  "/history",
  authenticateStaff,
  authorizeRoles("SYSTEM_ADMIN"),
  chatbotRateLimiter,
  validateQuery(chatbotHistoryQuerySchema),
  listChatbotConversationHistory,
);
chatbotRoutes.get(
  "/history/:sessionId",
  authenticateStaff,
  authorizeRoles("SYSTEM_ADMIN"),
  chatbotRateLimiter,
  validateParams(chatbotSessionParamsSchema),
  getChatbotConversationHistory,
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
chatbotRoutes.post(
  "/escalations/:sessionId/refer",
  authenticateStaff,
  authorizeRoles("SYSTEM_ADMIN"),
  chatbotRateLimiter,
  validateParams(chatbotSessionParamsSchema),
  validateBody(chatbotReferralSchema),
  referChatbotEscalation,
);

export default chatbotRoutes;
