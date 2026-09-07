import { AppError } from "../../utils/AppError.js";

export const NOTIFICATION_TYPES = Object.freeze([
  "SCHEDULE_CREATED",
  "SCHEDULE_UPDATED",
  "SCHEDULE_CANCELLED",
  "DISTRIBUTION_OPENED",
  "DISTRIBUTION_REMINDER",
  "CLAIM_VERIFIED",
  "BENEFIT_CREDITED_SIMULATED",
]);

export const MAX_SMS_MESSAGE_LENGTH = 320;
export const REMINDER_TEMPLATE_PLACEHOLDERS = Object.freeze([
  "beneficiary",
  "distribution",
  "date",
  "time",
  "location",
  "queue",
]);

function compactText(value, maximumLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maximumLength) return text;
  return `${text.slice(0, maximumLength - 1).trimEnd()}…`;
}

function scheduleTime(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AppError(409, "NOTIFICATION_TEMPLATE_CONTEXT_INVALID", "The schedule time is unavailable.");
  }
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(value);
}

function schedulePart(value, options) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AppError(409, "NOTIFICATION_TEMPLATE_CONTEXT_INVALID", "The schedule time is unavailable.");
  }
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    ...options,
  }).format(value);
}

function beneficiaryName(context) {
  return compactText([
    context.beneficiaryFirstName,
    context.beneficiaryMiddleName,
    context.beneficiaryLastName,
  ].filter(Boolean).join(" ") || "beneficiary", 100);
}

function templateContext(context) {
  return {
    title: compactText(context.distributionTitle, 70),
    location: compactText(context.location, 70),
    time: scheduleTime(context.slotStart),
    queue: Number(context.queueNumber),
  };
}

const TEMPLATE_RENDERERS = Object.freeze({
  SCHEDULE_CREATED: (value) => `GarantiyAid: Your schedule for ${value.title} is ${value.time} at ${value.location}. Queue ${value.queue}.`,
  SCHEDULE_UPDATED: (value) => `GarantiyAid: Your updated schedule for ${value.title} is ${value.time} at ${value.location}. Queue ${value.queue}.`,
  SCHEDULE_CANCELLED: (value) => `GarantiyAid: Your schedule for ${value.title} was cancelled. Contact your barangay office for assistance.`,
  DISTRIBUTION_OPENED: (value) => `GarantiyAid: ${value.title} is open. Your schedule is ${value.time} at ${value.location}, queue ${value.queue}.`,
  DISTRIBUTION_REMINDER: (value) => `GarantiyAid reminder: ${value.title} is on ${value.time} at ${value.location}. Queue ${value.queue}.`,
  CLAIM_VERIFIED: (value) => `GarantiyAid: Your claim for ${value.title} was verified. This notice does not confirm a payment.`,
  BENEFIT_CREDITED_SIMULATED: (value) => `GarantiyAid SIMULATION: A prototype benefit credit for ${value.title} was recorded. No real funds were transferred.`,
});

export function renderNotificationTemplate(notificationType, context) {
  const renderer = TEMPLATE_RENDERERS[notificationType];
  if (!renderer) {
    throw new AppError(400, "NOTIFICATION_TYPE_INVALID", "The notification type is not supported.");
  }
  const message = renderer(templateContext(context));
  if (message.length > MAX_SMS_MESSAGE_LENGTH) {
    throw new AppError(409, "NOTIFICATION_MESSAGE_TOO_LONG", "The controlled SMS template exceeds the safe length limit.");
  }
  return message;
}

export function renderReminderTemplate(messageTemplate, context) {
  const values = {
    beneficiary: beneficiaryName(context),
    distribution: compactText(context.distributionTitle, 70),
    date: schedulePart(context.slotStart, { year: "numeric", month: "short", day: "2-digit" }),
    time: schedulePart(context.slotStart, { hour: "numeric", minute: "2-digit", hour12: true }),
    location: compactText(context.location, 70),
    queue: String(Number(context.queueNumber)),
  };
  const message = String(messageTemplate ?? "").replace(/\{([a-z]+)\}/gi, (match, token) => (
    Object.hasOwn(values, token.toLowerCase()) ? values[token.toLowerCase()] : match
  )).trim();
  if (!message || message.length > MAX_SMS_MESSAGE_LENGTH) {
    throw new AppError(
      409,
      "NOTIFICATION_MESSAGE_TOO_LONG",
      `Each rendered reminder must contain 1-${MAX_SMS_MESSAGE_LENGTH} characters.`,
    );
  }
  return message;
}
