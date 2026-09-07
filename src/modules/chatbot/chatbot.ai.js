import OpenAI from "openai";
import { env } from "../../config/env.js";

export const OPENROUTER_CHATBOT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
export const OPENROUTER_FALLBACK_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";

const SAFE_EXTERNAL_INTENTS = new Set([
  "GREETING",
  "DOCUMENT_REQUIREMENTS",
  "PROGRAM_INFORMATION",
  "CLAIM_PROCESS",
  "STAFF_SCHEDULE",
  "STAFF_DELIVERY",
  "STAFF_BENEFICIARY",
  "STAFF_HELP",
  "STAFF_GREETING",
]);

const STAFF_GUIDANCE = Object.freeze({
  en: Object.freeze({
    GREETING: "Hello! I am ready to answer general GarantiyAid operations questions and guide you to reviewed staff workflows.",
    SCHEDULE: "Review schedules within your authorized workspace. Only System Administrators may create official distribution events.",
    DELIVERY: "Open SMS delivery to review queued, sent, and failed notification records within your authorized scope.",
    BENEFICIARY: "Use authorized beneficiary records to review Barangay, Sitio or Purok, and validated contact information for controlled recipient selection.",
    HELP: "I can guide you to schedules, delivery records, beneficiary records, or the reviewed reminder and distribution-draft workflows.",
  }),
  fil: Object.freeze({
    GREETING: "Kumusta! Handa akong sumagot sa pangkalahatang tanong tungkol sa GarantiyAid operations at gabayan ka sa reviewed staff workflows.",
    SCHEDULE: "Suriin ang schedules sa iyong awtorisadong workspace. System Administrator lamang ang makakagawa ng opisyal na distribution event.",
    DELIVERY: "Buksan ang SMS delivery para makita ang queued, sent, at failed notification records sa iyong awtorisadong scope.",
    BENEFICIARY: "Gamitin ang awtorisadong beneficiary records para suriin ang Barangay, Sitio o Purok, at validated contact information para sa kontroladong recipient selection.",
    HELP: "Maaari kitang gabayan sa schedules, delivery records, beneficiary records, at reviewed reminder o distribution-draft workflows.",
  }),
  ceb: Object.freeze({
    GREETING: "Oo, motubag ko. Maayong adlaw! Pangutan-a ko bahin sa GarantiyAid operations ug reviewed staff workflows.",
    SCHEDULE: "Ribyuha ang schedules sulod sa imong awtorisadong workspace. System Administrator ra ang makahimo og opisyal nga distribution event.",
    DELIVERY: "Ablihi ang SMS delivery aron makita ang queued, sent, ug failed notification records sulod sa imong awtorisadong scope.",
    BENEFICIARY: "Gamita ang awtorisadong beneficiary records sa pagribyu sa Barangay, Sitio o Purok, ug validated contact information para sa kontroladong recipient selection.",
    HELP: "Makatabang ko sa schedules, delivery records, beneficiary records, ug reviewed reminder o distribution-draft workflows.",
  }),
});

const SYSTEM_PROMPT = `You rewrite a pre-approved general government-service answer.
Use only facts present in the approved answer. Never add eligibility decisions, personal status, dates, amounts, names, contact details, links, or promises. Never request credentials, IDs, QR codes, biometric data, or document images. Do not mention internal reasoning. Reply in the requested language in at most 120 words.`;

const STAFF_SYSTEM_PROMPT = `You are the GarantiyAid assistant for authenticated government staff.
Answer the user's general operational question naturally and directly in the requested language. Stay within the approved guidance. Never claim to inspect or change records, approve eligibility or claims, move funds, verify biometrics, or schedule or send anything by yourself. Direct actions to the existing reviewed workflows. Never request credentials, IDs, QR codes, biometric data, document images, or personal records. Do not mention internal reasoning. Reply in at most 120 words.
Format answers in Markdown for a narrow chat panel. Use short paragraphs. For procedures, use a numbered list with each step on its own line; for options, use bullet points. Put a blank line before and after lists and headings. Use **bold labels** sparingly. Never run multiple numbered items together in one paragraph. When useful, show a small two-column Markdown table for comparisons or a short blockquote with arrows for a process; use only steps supported by the approved guidance. Do not invent counts, dates, or status data for a visual. Do not generate HTML, images, Mermaid, or executable code. Simple greetings need only a short sentence.
Never invent menu names, buttons, filters, or review/approval capabilities to fill out a list. State when the provided guidance lacks detailed steps. Verified schedule entry points: SYSTEM_ADMIN uses "Distribution setup"; DSWD_STAFF uses "Live monitoring"; BARANGAY_FACILITATOR uses "Queue & schedules". Refer only to the entry point matching the supplied staff role. These entry points do not imply permission to modify or confirm schedules.`;

export async function generateExternalChatbotAnswer({
  intent,
  language,
  approvedAnswer,
  promptMessages,
  apiKey = env.openRouterApiKey,
  client,
  model = OPENROUTER_CHATBOT_MODEL,
  timeoutMs = 15_000,
  signal: callerSignal,
  onText,
}) {
  callerSignal?.throwIfAborted();
  if (!apiKey || !SAFE_EXTERNAL_INTENTS.has(intent)) return null;

  try {
    const openrouter = client ?? new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      timeout: timeoutMs,
      maxRetries: 0,
      defaultHeaders: {
        "X-OpenRouter-Title": "GarantiyAid",
        ...(env.corsOrigins[0]?.startsWith("https://") ? { "HTTP-Referer": env.corsOrigins[0] } : {}),
      },
    });
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    const stream = await openrouter.chat.completions.create({
        model,
        stream: true,
        max_tokens: 400,
        temperature: 0.2,
        reasoning: { effort: "low", exclude: true },
        messages: promptMessages ?? [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({ language, intent, approvedAnswer }),
          },
        ],
    }, { signal });
    let messageText = "";
    let responseModel = model;
    let finishReason;
    for await (const chunk of stream) {
      signal.throwIfAborted();
      if (chunk.error) return null;
      if (typeof chunk.model === "string") responseModel = chunk.model;
      finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
      const content = chunk.choices?.[0]?.delta?.content;
      if (typeof content === "string") messageText += content;
      if (messageText.length > 2_000) return null;
      if (content) onText?.(messageText);
    }
    if (signal.aborted) return null;
    if (finishReason !== "stop") return null;
    const normalized = messageText.trim();
    return normalized ? { messageText: normalized, model: responseModel } : null;
  } catch {
    callerSignal?.throwIfAborted();
    return null;
  }
}

export function externalChatbotIntentAllowed(intent) {
  return SAFE_EXTERNAL_INTENTS.has(intent);
}

export async function generateStaffAssistantAnswer({
  intent,
  language,
  messageText,
  history = [],
  staffRole,
}, options = {}) {
  const selectedLanguage = Object.hasOwn(STAFF_GUIDANCE, language) ? language : "en";
  const safeIntent = Object.hasOwn(STAFF_GUIDANCE[selectedLanguage], intent) ? intent : "HELP";
  const approvedAnswer = STAFF_GUIDANCE[selectedLanguage][safeIntent];
  const externalRequest = {
    intent: `STAFF_${safeIntent}`,
    language: selectedLanguage,
    approvedAnswer,
    promptMessages: [
      {
        role: "system",
        content: `${STAFF_SYSTEM_PROMPT}\nRequested language: ${selectedLanguage}.\nStaff role: ${staffRole}.\nApproved guidance: ${approvedAnswer}`,
      },
      ...history,
      { role: "user", content: messageText },
    ],
    ...options,
  };
  let external = null;
  if (safeIntent !== "GREETING") {
    external = await generateExternalChatbotAnswer({ ...externalRequest, model: OPENROUTER_CHATBOT_MODEL, timeoutMs: 8_000 });
    options.signal?.throwIfAborted();
    if (!external) {
      options.onText?.("");
      options.onStatus?.("retrying");
      external = await generateExternalChatbotAnswer({ ...externalRequest, model: OPENROUTER_FALLBACK_MODEL, timeoutMs: 20_000 });
    }
  }
  options.signal?.throwIfAborted();
  if (!external) options.onText?.("");
  return {
    messageText: external?.messageText ?? approvedAnswer,
    externalAiUsed: Boolean(external),
    externalAiModel: external?.model ?? null,
    inputProcessedExternally: Boolean(external),
  };
}
