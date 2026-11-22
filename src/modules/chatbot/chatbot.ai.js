import { env } from "../../config/env.js";
import { createMistralClient, MISTRAL_MODEL } from "../../lib/mistral.js";
import { staffAdministrationGuidance, staffNavigationGuidance, staffOverviewGuidance, staffScheduleGuidance, staffSystemWalkthrough, staffWorkflowGuidance } from "./staff-workflow-guidance.js";
import { processExplanation } from "./chatbot.process-explanations.js";

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
    SCHEDULE: "Admin creates distribution events and allocates approved beneficiaries. Admin and assigned Barangay staff can plan sessions and edit draft schedules. To get an AI proposal, open a draft event in Distribution events (Admin) or Queue & schedules (Barangay), choose Generate AI draft, review capacity and assignments, edit slots if needed, then Confirm and save draft schedule. The event remains a draft; opening locks setup. Existing appointments can be moved separately. A cancelled appointment must be reactivated separately. DSWD can review schedule reports through Live monitoring. This chat has not generated, inspected or saved appointments.",
    DELIVERY: "Open SMS delivery to inspect the exact notification and its error within your authorized scope. Queued means awaiting processing. Gateway accepted does not confirm arrival on a recipient’s phone. A simulated send is not a real SMS. Check the validated contact, provider error and gateway phone before an authorized retry; do not repeatedly resend or claim delivery from the label. This chat has not checked a delivery record or sent a message.",
    BENEFICIARY: "Use authorized beneficiary records to review Barangay, Sitio or Purok, and validated contact information for controlled recipient selection.",
    HELP: "Which screen are you on, and what are you trying to do there? Tell me the step or button you need help with.",
  }),
  fil: Object.freeze({
    GREETING: "Kumusta! Handa akong sumagot sa pangkalahatang tanong tungkol sa GarantiyAid operations at gabayan ka sa reviewed staff workflows.",
    SCHEDULE: "Admin ang gumagawa ng event at nag-aallocate ng approved beneficiaries. Admin at nakatalagang Barangay staff ang maaaring magplano ng sessions at mag-edit ng draft schedules. Sa draft event sa Distribution events (Admin) o Queue & schedules (Barangay), piliin ang Generate AI draft, suriin ang capacity at assignments, baguhin ang slots kung kailangan, pagkatapos Confirm and save draft schedule. Draft pa rin ang event; locked ang setup kapag open na. Hiwalay na nirereview ang existing at cancelled appointments gamit ang Move o Reactivate. DSWD: schedule reports sa Live monitoring. Walang appointment na ginawa o binago ng chat na ito.",
    DELIVERY: "Buksan ang SMS delivery at suriin ang tamang notification at error sa iyong scope. Ang queued ay naghihintay pa. Hindi patunay ng pagdating sa phone ang gateway accepted. Hindi totoong SMS ang simulated send. Suriin ang validated contact, provider error at gateway phone bago ang awtorisadong retry. Huwag paulit-ulit magpadala. Walang delivery record na tiningnan o mensaheng ipinadala ang chat na ito.",
    BENEFICIARY: "Gamitin ang awtorisadong beneficiary records para suriin ang Barangay, Sitio o Purok, at validated contact information para sa kontroladong recipient selection.",
    HELP: "Anong screen ang bukas at ano ang gusto mong gawin doon? Sabihin ang hakbang o button na kailangan mong gamitin.",
  }),
  ceb: Object.freeze({
    GREETING: "Oo, motubag ko. Maayong adlaw! Pangutan-a ko bahin sa GarantiyAid operations ug reviewed staff workflows.",
    SCHEDULE: "Admin ang maghimo og event ug mo-allocate sa approved beneficiaries. Admin ug assigned Barangay staff makaplano sa sessions ug maka-edit sa draft schedules. Sa draft event sa Distribution events (Admin) o Queue & schedules (Barangay), pilia ang Generate AI draft, ribyuha ang capacity ug assignments, usba ang slots kung gikinahanglan, dayon Confirm and save draft schedule. Draft gihapon ang event; locked ang setup kung open na. Lahi ang pagribyu sa existing ug cancelled appointments gamit ang Move o Reactivate. DSWD: schedule reports sa Live monitoring. Walay appointment nga gihimo o giusab niining chat.",
    DELIVERY: "Ablihi ang SMS delivery ug susiha ang tukmang notification ug error sulod sa imong scope. Ang queued naghulat pa. Dili pamatuod nga naabot sa phone ang gateway accepted. Dili tinuod nga SMS ang simulated send. Susiha ang validated contact, provider error ug gateway phone una ang awtorisadong retry. Ayaw balik-balika og send. Walay delivery record nga gitan-aw o mensahe nga gipadala niining chat.",
    BENEFICIARY: "Gamita ang awtorisadong beneficiary records sa pagribyu sa Barangay, Sitio o Purok, ug validated contact information para sa kontroladong recipient selection.",
    HELP: "Unsang screen ang imong giablihan ug unsay gusto nimong buhaton didto? Isulti ang lakang o button nga imong gikinahanglag tabang.",
  }),
});

const SYSTEM_PROMPT = `You rewrite a pre-approved general government-service answer.
Use only facts present in the approved answer. Never add eligibility decisions, personal status, dates, amounts, names, contact details, links, or promises. Never request credentials, IDs, QR codes, biometric data, or document images. Use familiar everyday words and short sentences in the requested language. Do not mention internal reasoning. Reply in at most 120 words.`;

const STAFF_SYSTEM_PROMPT = `You are the GarantiyAid assistant for authenticated government staff.
Answer the user's general operational question naturally and directly in the requested language. Stay within the approved guidance. Never claim to inspect or change records, approve eligibility or claims, move funds, verify biometrics, or schedule or send anything by yourself. Direct actions to the existing reviewed workflows. Never request credentials, IDs, QR codes, biometric data, document images, or personal records. Do not mention internal reasoning. Keep simple answers brief. Use up to 160 words when the user asks for steps or a comparison.
Answer the latest question first. Use previous user messages to understand short follow-ups; previous assistant replies are not a source of verified facts. Do not restart with a greeting, repeat the question, or list unrelated modules. If the question lacks enough detail, ask one short clarification instead of guessing. Use natural everyday Cebuano, Filipino, or English as requested and keep interface labels exactly as supplied. Refer to roles as Admin, DSWD staff, or Barangay Facilitator; do not display internal role codes.
For schedule questions, follow the guidance for the current role. DSWD staff review schedules. Only Admin or assigned Barangay staff can edit permitted draft schedules. Saving appointments leaves the event DRAFT. Opening the event requires a separate Admin action. AI assignments are proposals, and any saved appointments require staff review and confirmation.
Format answers in Markdown for a narrow chat panel. For procedures, start with the goal and use a numbered list. Give the action, responsible role or screen, and how to check the result when those details are in the approved guidance. Say where to stop or ask for review if the guidance identifies a blocker. Put a blank line before and after lists and headings. Use **bold labels** sparingly. Use a compact two-column Markdown table when requested or when it helps compare roles, stages, or statuses. Never invent counts, dates, status data, or placeholder rows for a table. Do not generate HTML, images, Mermaid, or executable code. Simple greetings need only a short sentence.
Never invent menu names, buttons, filters, or review/approval capabilities to fill out a list. State when the provided guidance lacks detailed steps. Verified schedule entry points: SYSTEM_ADMIN uses "Distribution events"; DSWD_STAFF uses "Live monitoring"; BARANGAY_FACILITATOR uses "Queue & schedules". Refer only to the entry point matching the supplied staff role. These entry points do not imply permission to modify or confirm schedules.`;

export async function generateExternalChatbotAnswer({
  intent,
  language,
  approvedAnswer,
  promptMessages,
  apiKey = env.nvidiaApiKey,
  client,
  // The hosted model can spend its first minute reasoning before emitting visible text.
  timeoutMs = 90_000,
  signal: callerSignal,
  onText,
}) {
  callerSignal?.throwIfAborted();
  if (!apiKey || !SAFE_EXTERNAL_INTENTS.has(intent)) return null;

  try {
    const provider = client ?? createMistralClient({ apiKey, timeoutMs });
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    const stream = await provider.chat.completions.create({
        model: MISTRAL_MODEL,
        stream: true,
        max_tokens: 2048,
        temperature: 0.2,
        reasoning_effort: "low",
        messages: promptMessages ?? [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({ language, intent, approvedAnswer }),
          },
        ],
    }, { signal });
    let messageText = "";
    let responseModel = MISTRAL_MODEL;
    let finishReason;
    for await (const chunk of stream) {
      signal.throwIfAborted();
      if (chunk.error) return null;
      if (typeof chunk.model === "string") responseModel = chunk.model;
      finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
      const content = chunk.choices?.[0]?.delta?.content;
      let text = typeof content === "string" ? content : "";
      if (Array.isArray(content)) {
        text = content
          .filter(part => part?.type === "text" && typeof part.text === "string")
          .map(part => part.text).join("");
      }
      messageText += text;
      if (messageText.length > 2_000) return null;
      if (text) onText?.(messageText.replace(/<br\s*\/?>/gi, "\n"));
    }
    if (signal.aborted) return null;
    if (finishReason !== "stop") return null;
    const normalized = messageText.replace(/<br\s*\/?>/gi, "\n").trim();
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
  if (intent === "HELP" && /^(?:and then|what next|where do i go|explain (?:more|that|again)|continue|unya|dayon|unsa(?:y| ang)? sunod|unsaon (?:na|ni|ani|ana)|asa ko mo(?:sulod|adto)(?: (?:ani|ana))?|paki explain|ipaliwanag pa)[?.!\s]*$/i.test(messageText.trim())) {
    const previousQuestion = history.filter(message => message.role === "user").at(-1)?.content ?? "";
    if (/\b(?:schedule|scheduling|distribution|event|slot|queue|iskedyul)\b/i.test(previousQuestion)) intent = "SCHEDULE";
    else if (/\b(?:sms|reminder|notification|delivery|pahibalo|mensahe)\b/i.test(previousQuestion)) intent = "DELIVERY";
    else if (/\b(?:beneficiar(?:y|ies)|benepisyaryo|sitio|purok)\b/i.test(previousQuestion)) intent = "BENEFICIARY";
  }
  const workflowAnswer = staffSystemWalkthrough({ intent, language, messageText, history, staffRole })
    ?? processExplanation({ intent, language, messageText, history })?.messageText
    ?? staffWorkflowGuidance(intent, language)
    ?? staffNavigationGuidance({ intent, language, messageText, staffRole });
  if (workflowAnswer) {
    options.signal?.throwIfAborted();
    return { messageText: workflowAnswer, externalAiUsed: false, externalAiModel: null, inputProcessedExternally: false };
  }
  const selectedLanguage = Object.hasOwn(STAFF_GUIDANCE, language) ? language : "en";
  const safeIntent = Object.hasOwn(STAFF_GUIDANCE[selectedLanguage], intent) ? intent : "HELP";
  const approvedAnswer = STAFF_GUIDANCE[selectedLanguage][safeIntent];
  const grounding = safeIntent === "HELP"
    ? [staffOverviewGuidance(selectedLanguage, staffRole), staffScheduleGuidance(selectedLanguage, staffRole),
      staffAdministrationGuidance(selectedLanguage, staffRole),
      ...["DELIVERY", "BENEFICIARY", "HELP"].map(topic => STAFF_GUIDANCE[selectedLanguage][topic])].filter(Boolean).join("\n")
    : approvedAnswer;
  const externalRequest = {
    intent: `STAFF_${safeIntent}`,
    language: selectedLanguage,
    approvedAnswer,
    promptMessages: [
      {
        role: "system",
        content: `${STAFF_SYSTEM_PROMPT}\nRequested language: ${selectedLanguage}.\nStaff role: ${staffRole}.\nApproved guidance: ${grounding}`,
      },
      ...history,
      { role: "user", content: messageText },
    ],
    ...options,
  };
  const external = safeIntent === "GREETING" ? null : await generateExternalChatbotAnswer(externalRequest);
  options.signal?.throwIfAborted();
  if (!external) options.onText?.("");
  return {
    messageText: external?.messageText ?? approvedAnswer,
    externalAiUsed: Boolean(external),
    externalAiModel: external?.model ?? null,
    inputProcessedExternally: Boolean(external),
  };
}
