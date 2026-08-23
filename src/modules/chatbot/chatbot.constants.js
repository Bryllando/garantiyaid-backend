export const CHATBOT_LANGUAGES = Object.freeze(["en", "fil", "ceb"]);

export const CHATBOT_INTENTS = Object.freeze([
  "DOCUMENT_REQUIREMENTS",
  "PROGRAM_INFORMATION",
  "DISTRIBUTION_SCHEDULE",
  "CLAIM_STATUS",
  "ENROLLMENT_STATUS",
  "CLAIM_PROCESS",
  "HUMAN_ASSISTANCE",
  "GREETING",
  "UNKNOWN",
]);

export const CHATBOT_SESSION_STATUSES = Object.freeze([
  "ACTIVE",
  "ESCALATED",
  "RESOLVED",
  "ENDED",
]);

export const CHATBOT_ESCALATION_REASONS = Object.freeze([
  "LOW_CONFIDENCE",
  "UNKNOWN_INTENT",
  "PERSONAL_DATA_REQUIRED",
  "HUMAN_REQUESTED",
  "UNRESOLVED",
  "LEGACY_ESCALATION",
]);

export const CHATBOT_RESOLUTION_CODES = Object.freeze([
  "ANSWERED",
  "REFERRED_TO_BARANGAY",
  "REFERRED_TO_DSWD",
  "DUPLICATE_INQUIRY",
  "OUT_OF_SCOPE",
]);

export const CHATBOT_LOW_CONFIDENCE_THRESHOLD = 0.65;
export const CHATBOT_SESSION_TOKEN_HEADER = "x-chatbot-session-token";
export const CHATBOT_PROTOTYPE_DISCLOSURE =
  "Controlled prototype response; no external AI service or personal-record lookup was used.";

export const CHATBOT_STAFF_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "DSWD_STAFF",
  "BARANGAY_FACILITATOR",
]);

export const CHATBOT_TERMINAL_STATUSES = Object.freeze(["RESOLVED", "ENDED"]);
