import { CHATBOT_PROTOTYPE_DISCLOSURE } from "./chatbot.constants.js";

const KNOWLEDGE = Object.freeze({
  en: Object.freeze({
    GREETING: "Hello. I can give general guidance about documents, programs, distribution, enrollment, and the claim process. I cannot open personal records.",
    DOCUMENT_REQUIREMENTS: "Document requirements depend on the welfare program. Common examples may include a valid ID and supporting barangay or civil-registry documents, but only the current program checklist from authorized DSWD or barangay staff is official. Do not send document images or ID numbers in this chat.",
    PROGRAM_INFORMATION: "GarantiyAid is a web application used by authorized government staff to manage assistance programs, beneficiary enrollment, distribution schedules, verification, claims, and accountability records. To apply, ask your barangay or DSWD office which active program fits your situation, get its official document checklist, and submit the requirements through authorized staff. This chat cannot enroll you or decide eligibility.",
    DISTRIBUTION_SCHEDULE: "I cannot view or confirm a personal distribution schedule without beneficiary authentication. Check your official notification or contact authorized DSWD or barangay staff. I have escalated this inquiry for safe follow-up.",
    CLAIM_STATUS: "I cannot view or confirm a personal claim result without beneficiary authentication. A staff member must verify ownership before discussing a claim. I have escalated this inquiry for safe follow-up.",
    ENROLLMENT_STATUS: "I cannot view or confirm a personal enrollment result without beneficiary authentication. A staff member must verify ownership before discussing an application. I have escalated this inquiry for safe follow-up.",
    CLAIM_PROCESS: "For an assigned distribution, follow the official schedule and location, bring only the documents stated in your notice, and present the assigned QR credential when instructed. Authorized staff perform verification. This chatbot cannot approve claims, scan QR codes, or move funds.",
    HUMAN_ASSISTANCE: "I have escalated this session for staff follow-up. Do not post passwords, QR credentials, biometric data, PhilSys numbers, or full contact details in chat.",
    UNKNOWN: "I am not sure which service topic you mean. You can ask what GarantiyAid is, how to apply, which documents may be required, how enrollment or distribution works, or how to claim. If you need a person, say 'I need staff assistance.' Do not include sensitive identifiers or credentials.",
  }),
  fil: Object.freeze({
    GREETING: "Kumusta. Makapagbibigay ako ng pangkalahatang gabay tungkol sa mga dokumento, programa, distribusyon, enrollment, at proseso ng pag-claim. Hindi ako makakabukas ng personal na rekord.",
    DOCUMENT_REQUIREMENTS: "Nag-iiba ang kailangang dokumento ayon sa programa. Maaaring kabilang ang valid ID at mga dokumento mula sa barangay o civil registry, pero ang kasalukuyang checklist mula sa awtorisadong DSWD o barangay staff lamang ang opisyal. Huwag magpadala ng larawan ng dokumento o ID number dito.",
    PROGRAM_INFORMATION: "Ang GarantiyAid ay web application na ginagamit ng awtorisadong government staff para pamahalaan ang assistance programs, beneficiary enrollment, distribution schedules, verification, claims, at accountability records. Para mag-apply, magtanong sa barangay o DSWD office kung anong aktibong programa ang angkop sa iyong sitwasyon, kunin ang opisyal na document checklist, at isumite ang requirements sa awtorisadong staff. Hindi ka kayang i-enroll o pagpasyahan ang eligibility ng chat na ito.",
    DISTRIBUTION_SCHEDULE: "Hindi ko makikita o makukumpirma ang personal mong schedule nang walang beneficiary authentication. Tingnan ang opisyal na notification o makipag-ugnayan sa awtorisadong DSWD o barangay staff. In-escalate ko ito para sa ligtas na follow-up.",
    CLAIM_STATUS: "Hindi ko makikita o makukumpirma ang personal na claim nang walang beneficiary authentication. Kailangang beripikahin muna ng staff ang may-ari ng rekord. In-escalate ko ito para sa ligtas na follow-up.",
    ENROLLMENT_STATUS: "Hindi ko makikita o makukumpirma ang personal na enrollment nang walang beneficiary authentication. Kailangang beripikahin muna ng staff ang may-ari ng aplikasyon. In-escalate ko ito para sa ligtas na follow-up.",
    CLAIM_PROCESS: "Sundin ang opisyal na schedule at lokasyon, dalhin lamang ang mga dokumentong nasa notice, at ipakita ang nakatalagang QR credential kapag inutusan. Awtorisadong staff ang gumagawa ng verification. Hindi kayang mag-apruba ng claim, mag-scan ng QR, o maglipat ng pondo ang chatbot.",
    HUMAN_ASSISTANCE: "In-escalate ko ang session para sa follow-up ng staff. Huwag maglagay ng password, QR credential, biometric data, PhilSys number, o buong contact details dito.",
    UNKNOWN: "Hindi ako sigurado kung aling service topic ang ibig mong sabihin. Maaari mong itanong kung ano ang GarantiyAid, paano mag-apply, anong dokumento ang maaaring kailanganin, paano gumagana ang enrollment o distribusyon, o paano mag-claim. Sabihin ang 'Kailangan ko ng staff' kung gusto mong kumausap ng tao. Huwag maglagay ng sensitibong identifier o credential.",
  }),
  ceb: Object.freeze({
    GREETING: "Kumusta. Makahatag ko og kinatibuk-ang giya bahin sa dokumento, programa, distribution, enrollment, ug claim process. Dili ko makaabli og personal nga rekord.",
    DOCUMENT_REQUIREMENTS: "Nagdepende sa welfare program ang mga dokumentong gikinahanglan. Posibleng apil ang valid ID ug supporting barangay o civil-registry documents, apan ang kasamtangang checklist gikan sa awtorisadong DSWD o barangay staff ra ang opisyal. Ayaw ipadala ang hulagway sa dokumento o ID number dinhi.",
    PROGRAM_INFORMATION: "Ang GarantiyAid usa ka web application nga gigamit sa awtorisadong kawani sa gobyerno sa pagdumala sa assistance programs, beneficiary enrollment, distribution schedules, verification, claims, ug accountability records. Aron maka-apply, pangutan-a ang barangay o DSWD office kon unsang aktibong programa ang angay sa imong sitwasyon, kuhaa ang opisyal nga document checklist, ug isumite ang requirements pinaagi sa awtorisadong staff. Dili kini nga chat maka-enroll kanimo o makahukom sa eligibility.",
    DISTRIBUTION_SCHEDULE: "Dili nako makita o makumpirma ang imong personal nga schedule kung walay beneficiary authentication. Tan-awa ang opisyal nga notification o kontaka ang awtorisadong DSWD o barangay staff. Gi-escalate nako kini alang sa luwas nga follow-up.",
    CLAIM_STATUS: "Dili nako makita o makumpirma ang personal nga claim kung walay beneficiary authentication. Kinahanglan i-verify una sa staff ang tag-iya sa rekord. Gi-escalate nako kini alang sa luwas nga follow-up.",
    ENROLLMENT_STATUS: "Dili nako makita o makumpirma ang personal nga enrollment kung walay beneficiary authentication. Kinahanglan i-verify una sa staff ang tag-iya sa aplikasyon. Gi-escalate nako kini alang sa luwas nga follow-up.",
    CLAIM_PROCESS: "Sunda ang opisyal nga schedule ug lugar, dad-a lamang ang mga dokumentong naa sa notice, ug ipakita ang gi-assign nga QR credential kung suguon. Awtorisadong staff ang mo-verify. Dili maka-approve og claim, maka-scan og QR, o makabalhin og pondo ang chatbot.",
    HUMAN_ASSISTANCE: "Gi-escalate nako ang session alang sa follow-up sa staff. Ayaw pag-post og password, QR credential, biometric data, PhilSys number, o tibuok contact details dinhi.",
    UNKNOWN: "Dili pa klaro kung unsang service topic ang imong pasabot. Mahimo kang mangutana kung unsa ang GarantiyAid, unsaon pag-apply, unsang dokumento ang posibleng kinahanglan, unsaon ang enrollment o distribution, o unsaon pag-claim. Isulti ang 'Kinahanglan ko og staff' kung gusto kang makigstorya og tawo. Ayaw paglakip og sensitibong identifier o credential.",
  }),
});

const ESCALATED_INTENTS = new Set([
  "DISTRIBUTION_SCHEDULE",
  "CLAIM_STATUS",
  "ENROLLMENT_STATUS",
  "HUMAN_ASSISTANCE",
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
