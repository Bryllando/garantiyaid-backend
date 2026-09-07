import { z } from "zod";
import { env } from "../../config/env.js";
import {
  CHATBOT_LANGUAGES,
  CHATBOT_RESOLUTION_CODES,
} from "./chatbot.constants.js";

const language = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.enum(CHATBOT_LANGUAGES),
);

function noHtmlMarkup(value) {
  return !/<\/?[a-z][^>]*>/i.test(value) && !/<script\b/i.test(value);
}

const messageText = z.string()
  .trim()
  .min(1, "messageText is required.")
  .max(1_000, "messageText must not exceed 1000 characters.")
  .refine(noHtmlMarkup, "HTML markup is not allowed in chatbot messages.");

const booleanQuery = z.preprocess((value) => {
  if (value === "true" || value === true) return true;
  if (value === "false" || value === false) return false;
  return value;
}, z.boolean());

export const createChatbotSessionSchema = z.object({
  language: language.default("en"),
}).strict();

export const chatbotSessionParamsSchema = z.object({
  sessionId: z.uuid(),
}).strict();

export const chatbotMessageSchema = z.object({
  messageText,
}).strict();

export const chatbotMessageListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export const chatbotEscalateSchema = z.object({
  reason: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(["HUMAN_REQUESTED", "UNRESOLVED"]).default("HUMAN_REQUESTED"),
  ),
}).strict();

export const endChatbotSessionSchema = z.object({}).strict();

export const chatbotEscalationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(["ESCALATED", "RESOLVED"]).default("ESCALATED"),
  ),
  barangayId: z.uuid().optional(),
  assignedToMe: booleanQuery.optional().default(false),
}).strict();

export const chatbotStaffReplySchema = z.object({
  messageText,
}).strict();

export const chatbotResolveSchema = z.object({
  resolutionCode: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(CHATBOT_RESOLUTION_CODES),
  ),
}).strict();

export const staffAssistantFeedbackSchema = z.object({
  rating: z.enum(["HELPFUL", "NEEDS_IMPROVEMENT"]),
  context: z.enum(["GUIDANCE", "DISTRIBUTION_DRAFT", "REMINDER_PREVIEW", "REMINDER_QUEUED"]),
  intent: z.string().trim().min(1).max(50).regex(/^[A-Z_]+$/).optional(),
}).strict();

export const staffAssistantMessageSchema = z.object({
  language: language.default("en"),
  intent: z.enum(["GREETING", "SCHEDULE", "DELIVERY", "BENEFICIARY", "HELP"]),
  messageText: messageText.refine((value) => value.length <= 300, "messageText must not exceed 300 characters."),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: messageText,
  }).strict()).max(6).default([]),
}).strict();

export const CHATBOT_LIMITS = Object.freeze({
  maximumMessageLength: 1_000,
  maximumMessagesPerSession: env.chatbotMaxMessagesPerSession,
  maximumSessionHours: env.chatbotSessionMaxHours,
  retentionDays: env.chatbotRetentionDays,
});
