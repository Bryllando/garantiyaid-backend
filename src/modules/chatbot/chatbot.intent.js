import {
  CHATBOT_LOW_CONFIDENCE_THRESHOLD,
} from "./chatbot.constants.js";

const INTENT_RULES = Object.freeze([
  {
    intent: "HUMAN_ASSISTANCE",
    exact: ["human", "staff", "agent", "help me", "tabang", "tawo"],
    phrases: [
      "talk to a person",
      "talk to someone",
      "speak to staff",
      "human assistance",
      "contact dswd",
      "contact barangay",
      "barangay staff",
      "need human help",
      "kinahanglan kog tabang",
      "makigstorya sa staff",
    ],
    keywords: ["human", "staff", "agent", "person", "dswd", "tabang"],
  },
  {
    intent: "DOCUMENT_REQUIREMENTS",
    exact: ["requirements", "documents", "document requirements", "mga dokumento"],
    phrases: [
      "documentary requirements",
      "required documents",
      "documents do i need",
      "what documents",
      "valid id",
      "birth certificate",
      "barangay certificate",
      "requirements for enrollment",
      "mga kinahanglan nga dokumento",
      "anong dokumento",
    ],
    keywords: ["document", "documents", "requirements", "requirement", "dokumento", "certificate"],
  },
  {
    intent: "ENROLLMENT_STATUS",
    exact: ["enrollment status", "application status"],
    phrases: [
      "enrollment status",
      "application status",
      "status of my enrollment",
      "status of my application",
      "is my enrollment approved",
      "enrollment approved",
      "application approved",
      "na approve akong enrollment",
      "estado ng aplikasyon",
    ],
    keywords: ["enrollment", "application", "aplikasyon", "enrolment"],
  },
  {
    intent: "CLAIM_STATUS",
    exact: ["claim status"],
    phrases: [
      "claim status",
      "status of my claim",
      "is my claim approved",
      "has my claim been processed",
      "claim already approved",
      "estado ng claim",
      "status sa claim",
    ],
    keywords: ["claim", "claimed"],
  },
  {
    intent: "CLAIM_PROCESS",
    exact: ["claim process", "how to claim"],
    phrases: [
      "how do i claim",
      "what should i bring to claim",
      "what to bring when claiming",
      "claiming process",
      "qr verification",
      "qr code for claiming",
      "biometric verification",
      "paano mag claim",
      "unsaon pag claim",
    ],
    keywords: ["claim", "claiming", "qr", "biometric", "process"],
  },
  {
    intent: "DISTRIBUTION_SCHEDULE",
    exact: ["schedule", "distribution schedule", "payout schedule"],
    phrases: [
      "when is my schedule",
      "distribution date",
      "claiming schedule",
      "payout date",
      "queue number",
      "time slot",
      "when can i claim",
      "kanus a ang schedule",
      "kailan ang schedule",
    ],
    keywords: ["schedule", "distribution", "payout", "queue", "slot", "iskedyul"],
  },
  {
    intent: "PROGRAM_INFORMATION",
    exact: ["program information", "programs"],
    phrases: [
      "what is garantiyaid",
      "what is this system",
      "how can i apply",
      "how do i apply",
      "how to apply",
      "apply for assistance",
      "welfare program",
      "available programs",
      "program details",
      "about the program",
      "who can apply",
      "eligibility information",
      "ano ang garantiyaid",
      "paano mag apply",
      "unsa ang garantiyaid",
      "unsa ni nga system",
      "unsaon pag apply",
      "impormasyon sa programa",
      "programa sa dswd",
    ],
    keywords: ["program", "programs", "programa", "welfare", "eligibility", "garantiyaid", "apply"],
  },
]);

const GREETINGS = new Set([
  "hello",
  "hi",
  "hey",
  "good morning",
  "good afternoon",
  "good evening",
  "kamusta",
  "kumusta",
  "maayong buntag",
  "maayong hapon",
]);

export function normalizeChatbotText(value) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[\u2019']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreRule(text, words, rule) {
  if (rule.exact.includes(text)) return 0.99;

  let score = 0;
  for (const phrase of rule.phrases) {
    if (text.includes(phrase)) {
      const wordCount = phrase.split(" ").length;
      score = Math.max(score, wordCount >= 3 ? 0.92 : 0.86);
    }
  }

  const keywordMatches = rule.keywords.filter((keyword) => (
    keyword.includes(" ") ? text.includes(keyword) : words.has(keyword)
  )).length;
  if (keywordMatches > 0) {
    score = Math.max(score, 0.58 + Math.min(keywordMatches, 3) * 0.1);
  }
  return Math.min(score, 0.99);
}

export function classifyChatbotIntent(messageText) {
  const normalizedText = normalizeChatbotText(messageText);
  if (!normalizedText) {
    return { intent: "UNKNOWN", confidence: 0, normalizedText };
  }
  if (GREETINGS.has(normalizedText)) {
    return { intent: "GREETING", confidence: 0.99, normalizedText };
  }

  const words = new Set(normalizedText.split(" "));
  const scores = INTENT_RULES
    .map((rule) => ({ intent: rule.intent, confidence: scoreRule(normalizedText, words, rule) }))
    .sort((left, right) => right.confidence - left.confidence || left.intent.localeCompare(right.intent));
  const best = scores[0];
  const second = scores[1];
  if (!best || best.confidence < CHATBOT_LOW_CONFIDENCE_THRESHOLD) {
    return {
      intent: "UNKNOWN",
      confidence: Number((best?.confidence ?? 0).toFixed(4)),
      normalizedText,
    };
  }
  if (second?.confidence >= CHATBOT_LOW_CONFIDENCE_THRESHOLD && best.confidence - second.confidence < 0.08) {
    return { intent: "UNKNOWN", confidence: 0.4, normalizedText };
  }
  return {
    intent: best.intent,
    confidence: Number(best.confidence.toFixed(4)),
    normalizedText,
  };
}
