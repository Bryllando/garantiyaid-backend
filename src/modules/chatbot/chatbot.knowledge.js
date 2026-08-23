import { CHATBOT_PROTOTYPE_DISCLOSURE } from "./chatbot.constants.js";

const KNOWLEDGE = Object.freeze({
  en: Object.freeze({
    GREETING: "Hello. I can give general guidance about documents, programs, distribution, enrollment, and the claim process. I cannot open personal records.",
    DOCUMENT_REQUIREMENTS: "Document requirements depend on the welfare program. Common examples may include a valid ID and supporting barangay or civil-registry documents, but only the current program checklist from authorized DSWD or barangay staff is official. Do not send document images or ID numbers in this chat.",
    PROGRAM_INFORMATION: "GarantiyAid supports controlled information about welfare programs recorded by authorized staff. Program eligibility, application periods, and benefits vary. Confirm the current rules with DSWD or your barangay office; this chatbot does not decide eligibility.",
    DISTRIBUTION_SCHEDULE: "I cannot view or confirm a personal distribution schedule without beneficiary authentication. Check your official notification or contact authorized DSWD or barangay staff. I have escalated this inquiry for safe follow-up.",
    CLAIM_STATUS: "I cannot view or confirm a personal claim result without beneficiary authentication. A staff member must verify ownership before discussing a claim. I have escalated this inquiry for safe follow-up.",
    ENROLLMENT_STATUS: "I cannot view or confirm a personal enrollment result without beneficiary authentication. A staff member must verify ownership before discussing an application. I have escalated this inquiry for safe follow-up.",
    CLAIM_PROCESS: "For an assigned distribution, follow the official schedule and location, bring only the documents stated in your notice, and present the assigned QR credential when instructed. Authorized staff perform verification. This chatbot cannot approve claims, scan QR codes, or move funds.",
    HUMAN_ASSISTANCE: "I have escalated this session for staff follow-up. Do not post passwords, QR credentials, biometric data, PhilSys numbers, or full contact details in chat.",
    UNKNOWN: "I could not match that question to the controlled knowledge base. I have escalated it for staff follow-up. Do not include sensitive identifiers or credentials.",
  }),
  fil: Object.freeze({
    GREETING: "Kumusta. Makapagbibigay ako ng pangkalahatang gabay tungkol sa mga dokumento, programa, distribusyon, enrollment, at proseso ng pag-claim. Hindi ako makakabukas ng personal na rekord.",
    DOCUMENT_REQUIREMENTS: "Nag-iiba ang kailangang dokumento ayon sa programa. Maaaring kabilang ang valid ID at mga dokumento mula sa barangay o civil registry, pero ang kasalukuyang checklist mula sa awtorisadong DSWD o barangay staff lamang ang opisyal. Huwag magpadala ng larawan ng dokumento o ID number dito.",
    PROGRAM_INFORMATION: "Nagbibigay ang GarantiyAid ng kontroladong impormasyon tungkol sa mga programang inilagay ng awtorisadong staff. Nag-iiba ang eligibility, application period, at benepisyo. Kumpirmahin ang kasalukuyang patakaran sa DSWD o barangay; hindi nagpapasya ang chatbot tungkol sa eligibility.",
    DISTRIBUTION_SCHEDULE: "Hindi ko makikita o makukumpirma ang personal mong schedule nang walang beneficiary authentication. Tingnan ang opisyal na notification o makipag-ugnayan sa awtorisadong DSWD o barangay staff. In-escalate ko ito para sa ligtas na follow-up.",
    CLAIM_STATUS: "Hindi ko makikita o makukumpirma ang personal na claim nang walang beneficiary authentication. Kailangang beripikahin muna ng staff ang may-ari ng rekord. In-escalate ko ito para sa ligtas na follow-up.",
    ENROLLMENT_STATUS: "Hindi ko makikita o makukumpirma ang personal na enrollment nang walang beneficiary authentication. Kailangang beripikahin muna ng staff ang may-ari ng aplikasyon. In-escalate ko ito para sa ligtas na follow-up.",
    CLAIM_PROCESS: "Sundin ang opisyal na schedule at lokasyon, dalhin lamang ang mga dokumentong nasa notice, at ipakita ang nakatalagang QR credential kapag inutusan. Awtorisadong staff ang gumagawa ng verification. Hindi kayang mag-apruba ng claim, mag-scan ng QR, o maglipat ng pondo ang chatbot.",
    HUMAN_ASSISTANCE: "In-escalate ko ang session para sa follow-up ng staff. Huwag maglagay ng password, QR credential, biometric data, PhilSys number, o buong contact details dito.",
    UNKNOWN: "Hindi ko maitugma ang tanong sa kontroladong knowledge base. In-escalate ko ito para sa follow-up ng staff. Huwag maglagay ng sensitibong identifier o credential.",
  }),
  ceb: Object.freeze({
    GREETING: "Kumusta. Makahatag ko og kinatibuk-ang giya bahin sa dokumento, programa, distribution, enrollment, ug claim process. Dili ko makaabli og personal nga rekord.",
    DOCUMENT_REQUIREMENTS: "Nagdepende sa welfare program ang mga dokumentong gikinahanglan. Posibleng apil ang valid ID ug supporting barangay o civil-registry documents, apan ang kasamtangang checklist gikan sa awtorisadong DSWD o barangay staff ra ang opisyal. Ayaw ipadala ang hulagway sa dokumento o ID number dinhi.",
    PROGRAM_INFORMATION: "Ang GarantiyAid naghatag og kontroladong impormasyon sa welfare programs nga gi-record sa awtorisadong staff. Nagkalahi ang eligibility, application period, ug benepisyo. Kumpirmaha ang kasamtangang lagda sa DSWD o barangay; dili ang chatbot ang mohukom sa eligibility.",
    DISTRIBUTION_SCHEDULE: "Dili nako makita o makumpirma ang imong personal nga schedule kung walay beneficiary authentication. Tan-awa ang opisyal nga notification o kontaka ang awtorisadong DSWD o barangay staff. Gi-escalate nako kini alang sa luwas nga follow-up.",
    CLAIM_STATUS: "Dili nako makita o makumpirma ang personal nga claim kung walay beneficiary authentication. Kinahanglan i-verify una sa staff ang tag-iya sa rekord. Gi-escalate nako kini alang sa luwas nga follow-up.",
    ENROLLMENT_STATUS: "Dili nako makita o makumpirma ang personal nga enrollment kung walay beneficiary authentication. Kinahanglan i-verify una sa staff ang tag-iya sa aplikasyon. Gi-escalate nako kini alang sa luwas nga follow-up.",
    CLAIM_PROCESS: "Sunda ang opisyal nga schedule ug lugar, dad-a lamang ang mga dokumentong naa sa notice, ug ipakita ang gi-assign nga QR credential kung suguon. Awtorisadong staff ang mo-verify. Dili maka-approve og claim, maka-scan og QR, o makabalhin og pondo ang chatbot.",
    HUMAN_ASSISTANCE: "Gi-escalate nako ang session alang sa follow-up sa staff. Ayaw pag-post og password, QR credential, biometric data, PhilSys number, o tibuok contact details dinhi.",
    UNKNOWN: "Wala nako matugma ang pangutana sa kontroladong knowledge base. Gi-escalate nako kini alang sa follow-up sa staff. Ayaw paglakip og sensitibong identifier o credential.",
  }),
});

const ESCALATED_INTENTS = new Set([
  "DISTRIBUTION_SCHEDULE",
  "CLAIM_STATUS",
  "ENROLLMENT_STATUS",
  "HUMAN_ASSISTANCE",
  "UNKNOWN",
]);

const PERSONAL_INTENTS = new Set([
  "DISTRIBUTION_SCHEDULE",
  "CLAIM_STATUS",
  "ENROLLMENT_STATUS",
]);

export function controlledChatbotAnswer(intent, language = "en") {
  const selectedLanguage = Object.hasOwn(KNOWLEDGE, language) ? language : "en";
  const safeIntent = Object.hasOwn(KNOWLEDGE[selectedLanguage], intent) ? intent : "UNKNOWN";
  return {
    messageText: KNOWLEDGE[selectedLanguage][safeIntent],
    intent: safeIntent,
    language: selectedLanguage,
    requiresEscalation: ESCALATED_INTENTS.has(safeIntent),
    requiresPersonalAuthentication: PERSONAL_INTENTS.has(safeIntent),
    personalDataAccessed: false,
    externalAiUsed: false,
    prototypeDisclosure: CHATBOT_PROTOTYPE_DISCLOSURE,
  };
}

export function escalationReasonForIntent(intent, confidence) {
  if (PERSONAL_INTENTS.has(intent)) return "PERSONAL_DATA_REQUIRED";
  if (intent === "HUMAN_ASSISTANCE") return "HUMAN_REQUESTED";
  if (intent === "UNKNOWN" && confidence > 0) return "LOW_CONFIDENCE";
  return "UNKNOWN_INTENT";
}
