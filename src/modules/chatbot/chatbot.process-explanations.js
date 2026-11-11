// These describe implemented software processes, not program policy or a person's recorded progress.
export const PROCESS_EXPLANATIONS = {
  APPROVAL_SCHEDULING: {
    titles: ['Approval and scheduling', 'Pag-apruba at iskedyul', 'Approval ug schedule'],
    answers: [
      'Application approval is a decision on the application. Allocation and an assigned appointment are separate records. This general process does not confirm anyone’s approval or appointment. Check the exact authorized record before giving a distribution date.',
      'Desisyon sa application ang approval. Hiwalay ang allocation at appointment. Pangkalahatang proseso ito; hindi nito kinukumpirma ang approval o appointment ng sinuman. Suriin ang tamang awtorisadong record bago magbigay ng petsa.',
      'Desisyon sa application ang approval. Lahi nga records ang allocation ug appointment. Kinatibuk-ang proseso kini; dili kini mokumpirma sa approval o appointment ni bisan kinsa. Susiha ang tukmang awtorisadong record una mohatag og petsa.',
    ],
  },
  IDENTITY_RELEASE: {
    titles: ['Identity checks and release', 'Identity checks at release', 'Identity checks ug release'],
    answers: [
      'A verified QR is one identity check. Every check required by the event must be satisfied before the permitted release or settlement workflow. Staff record the actual release separately; a receipt follows an eligible completed release or settlement. This is general guidance, not a claim-status lookup.',
      'Isang identity check ang verified QR. Kailangang makumpleto ang lahat ng required checks ng event bago ang pinapayagang release o settlement. Hiwalay ang pagtatala ng aktuwal na release; saka maaaring mag-issue ng receipt. Pangkalahatang gabay ito, hindi personal claim status.',
      'Usa ka identity check ang verified QR. Kinahanglan makompleto ang tanang required checks sa event una ang gitugot nga release o settlement. Lahi ang pagtala sa aktuwal nga release; human niini mahimong mag-issue og receipt kung eligible. Kinatibuk-ang giya kini, dili personal claim status.',
    ],
  },
  APPLICATION_CORRECTION: {
    titles: ['Application corrections', 'Pagwawasto ng application', 'Pagtul-id sa application'],
    answers: [
      'Review the recorded correction request, prepare the requested corrections, and submit them through authorized staff for review. A correction does not guarantee approval. Confirm any unclear document requirement with the responsible office; do not create a duplicate person to avoid a correction.',
      'Suriin ang nakatalang correction request, ihanda ang hinihinging pagwawasto, at isumite sa awtorisadong staff para sa review. Hindi garantiya ng approval ang correction. Kumpirmahin sa responsableng opisina ang hindi malinaw na requirement; huwag gumawa ng duplicate person.',
      'Ribyuha ang natala nga correction request, andama ang gipangayong pagtul-id, ug isumite pinaagi sa awtorisadong staff alang sa review. Dili garantiya sa approval ang correction. Kumpirmaha sa responsableng opisina ang dili klarong requirement; ayaw paghimo og duplicate person.',
    ],
  },
  SMS_DELIVERY: {
    titles: ['SMS processing', 'Pagproseso ng SMS', 'Pagproseso sa SMS'],
    answers: [
      'After recipient review and explicit confirmation, reminders enter the notification queue. Simulation sends no real SMS. For real SMS, gateway acceptance does not prove arrival on a phone. Inspect the exact delivery record and any provider error before an authorized retry. This diagram does not report a particular message as sent or received.',
      'Pagkatapos ng recipient review at tahasang confirmation, mapupunta ang reminders sa queue. Walang totoong SMS sa simulation. Hindi patunay ng pagdating sa phone ang gateway acceptance. Suriin ang tamang delivery record at provider error bago ang awtorisadong retry. Hindi delivery report ng personal na mensahe ang diagram.',
      'Human sa recipient review ug klarong confirmation, mosulod sa queue ang reminders. Walay tinuod nga SMS sa simulation. Dili pamatuod sa pag-abot sa phone ang gateway acceptance. Susiha ang tukmang delivery record ug provider error una ang awtorisadong retry. Dili delivery report sa personal nga mensahe ang diagram.',
    ],
  },
  APPLICATION_STEPS: {
    titles: ['Application steps', 'Mga hakbang sa application', 'Mga lakang sa application'],
    answers: [
      'Check the selected program’s official requirements with the responsible office, prepare those documents, and submit through its authorized channel for review. Requirements and eligibility depend on the program. This is a general process, not a document checklist or a promise of approval.',
      'Kumpirmahin sa responsableng opisina ang opisyal na requirements ng tamang programa, ihanda ang mga dokumentong iyon, at isumite sa awtorisadong channel para sa review. Depende sa programa ang requirements at eligibility. Pangkalahatang proseso ito, hindi document checklist o pangako ng approval.',
      'Kumpirmaha sa responsableng opisina ang opisyal nga requirements sa tukmang programa, andama kadtong mga dokumento, ug isumite sa awtorisadong channel alang sa review. Depende sa programa ang requirements ug eligibility. Kinatibuk-ang proseso kini, dili document checklist o saad sa approval.',
    ],
  },
  FACE_PROFILE: {
    titles: ['Face enrollment and verification', 'Face enrollment at verification', 'Face enrollment ug verification'],
    answers: [
      'A photo alone is not a verified identity. Live face verification needs active consent and an enrolled, cleared face profile to compare against the live capture. A failed or unavailable match needs authorized review. Completing a face check still does not record assistance release.',
      'Hindi verified identity ang litrato lamang. Kailangan ng active consent at enrolled, cleared face profile na ikukumpara sa live capture. Kailangan ng awtorisadong review kung failed o unavailable ang match. Hindi pa release record ang completed face check.',
      'Dili verified identity ang litrato lamang. Kinahanglan og active consent ug enrolled, cleared face profile nga ikumpara sa live capture. Kinahanglan og awtorisadong review kung failed o unavailable ang match. Dili pa release record ang completed face check.',
    ],
  },
};

export const PROCESS_PREFIXES = ['General process: ', 'Pangkalahatang proseso: ', 'Kinatibuk-ang proseso: '];
const normalize = text => text.normalize('NFKC').toLowerCase().replace(/\baplication\b/g, 'application').replace(/\bschduled\b/g, 'scheduled');

export function processTemplateForQuestion(messageText, history = []) {
  let text = normalize(messageText);
  if (/\b(?:text only|no diagram|without a diagram|ayaw.{0,10}diagram|walang diagram|bypass|ignore.{0,25}permission|approve all)\b/.test(text)) return null;
  const followUp = /^(?:show (?:that|the|its) (?:flow|diagram)|ipakita (?:ang|kadtong) flow|ipakita ang daloy|why is it blocked)[.?!\s]*$/.test(text);
  if (followUp) {
    const previous = history.filter(message => message.role === 'user').at(-1)?.content;
    if (!previous) return null;
    text = normalize(previous);
  }
  if (/\b(?:check|show|lookup|look up)\s+(?:my|his|her|their|juan|maria)\b/.test(text)) return null;
  const process = followUp || /\b(?:how|why|explain|steps|process|difference|compare|diagram|flow|unsaon|ngano|nganong|ipasabot|proseso|paano|bakit|ipaliwanag)\b/.test(text);
  const approval = /\b(?:approved|approval|aprubado|gi.approve)\b/.test(text);
  const schedule = /\b(?:schedule|scheduled|scheduling|appointment|iskedyul)\b/.test(text);
  if (approval && schedule && (process || /\b(?:but|pero|not|wala|walang|no)\b/.test(text))) return 'APPROVAL_SCHEDULING';
  if (!process) return null;
  if (/\b(?:qr|identity|verified)\b/.test(text) && /\b(?:release|released|releasing|handover|receipt|resibo|credit|settlement)\b/.test(text)) return 'IDENTITY_RELEASE';
  if (/\b(?:face|photo|litrato|picture)\b/.test(text)) return 'FACE_PROFILE';
  if (/\b(?:sms|gateway|text message)\b/.test(text)) return 'SMS_DELIVERY';
  if (/\b(?:correction|corrections|correct|missing|kulang|pagwawasto|tul.id)\b/.test(text) && /\b(?:application|document|documents|enrollment|enrolment|dokumento|papeles)\b/.test(text)) return 'APPLICATION_CORRECTION';
  if (/\b(?:apply|application|mag.apply|aplikasyon)\b/.test(text)) return 'APPLICATION_STEPS';
  return null;
}

export function processExplanation({ messageText, language = 'en', history = [], intent, publicChat = false }) {
  if (publicChat && !['PROGRAM_INFORMATION', 'DOCUMENT_REQUIREMENTS', 'CLAIM_PROCESS'].includes(intent)) return null;
  if (['GREETING', 'UNKNOWN', 'MOBILE', 'CONCERN', 'HUMAN_ASSISTANCE', 'UNSUPPORTED', 'CANCEL', 'CLARIFY', 'PREPARE_AREA_REMINDER', 'CREATE_DISTRIBUTION_DRAFT'].includes(intent)) return null;
  if (/\b(?:push|mobile notification)\b/i.test(messageText)) return null;
  const templateId = processTemplateForQuestion(messageText, history);
  if (!templateId) return null;
  const index = { en: 0, fil: 1, ceb: 2 }[language] ?? 0;
  const template = PROCESS_EXPLANATIONS[templateId];
  return { templateId, messageText: `${PROCESS_PREFIXES[index]}${template.titles[index]}\n\n${template.answers[index]}` };
}
