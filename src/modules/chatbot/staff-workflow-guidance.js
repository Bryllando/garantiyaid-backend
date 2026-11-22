// Grounded in the implemented screens and policies. Draft beneficiary FAQs are review material, not published policy.
import { isSystemOverviewQuestion, normalizeChatbotText } from "./chatbot.intent.js";

export const STAFF_WORKFLOW_GUIDANCE = {
  DOCUMENT_REQUIREMENTS: [
    '1. Open Assistance programs and check the selected program’s published requirements.\n2. Review the beneficiary’s documents in the authorized record.\n3. Explain missing items and the correction process. Confirm unclear requirements with the responsible office.\n\nEligibility, documents and assistance amounts depend on the program. I cannot decide eligibility or inspect a personal application in this conversation.',
    '1. Buksan ang Assistance programs at tingnan ang requirements ng tamang programa.\n2. Suriin ang mga dokumento sa awtorisadong beneficiary record.\n3. Ipaliwanag ang kulang at proseso ng pagwawasto. Kumpirmahin sa responsableng opisina ang hindi malinaw.\n\nDepende sa programa ang eligibility, dokumento at halaga. Hindi ako makakapagpasya ng eligibility o makakakita ng personal application dito.',
    '1. Ablihi ang Assistance programs ug tan-awa ang requirements sa tukmang programa.\n2. Ribyuha ang mga dokumento sa awtorisadong beneficiary record.\n3. Ipasabot ang kulang ug correction process. Kumpirmaha sa responsableng opisina ang dili klaro.\n\nDepende sa programa ang eligibility, dokumento ug kantidad. Dili ko makadesisyon sa eligibility o makatan-aw sa personal application dinhi.',
  ],
  ENROLLMENT: [
    '1. Open Enrollment review (Enrollments for Barangay staff).\n2. Select the exact beneficiary and program; inspect the recorded status and correction requests.\n3. Use only the review actions your role permits. Barangay submissions and corrections still need the authorized decision process.\n\nApproved → allocated → scheduled → identity checked → assistance released are separate records. I have not approved or changed an application.',
    '1. Buksan ang Enrollment review (Enrollments para sa Barangay staff).\n2. Piliin ang tamang beneficiary at programa; tingnan ang status at correction requests.\n3. Gamitin lamang ang review actions na pinapayagan sa iyong role. Kailangan pa rin ng awtorisadong desisyon ang Barangay submissions at corrections.\n\nMagkaiba ang approved, allocated, scheduled, identity checked at assistance released. Wala akong inaprubahan o binagong application.',
    '1. Ablihi ang Enrollment review (Enrollments para sa Barangay staff).\n2. Pilia ang tukmang beneficiary ug programa; susiha ang status ug correction requests.\n3. Gamita lamang ang review actions nga gitugotan sa imong role. Kinahanglan gihapon og awtorisadong desisyon ang Barangay submissions ug corrections.\n\nLahi ang approved, allocated, scheduled, identity checked ug assistance released. Wala koy gi-approve o giusab nga application.',
  ],
  IDENTITY: [
    '1. Check the event’s required identity checks and the beneficiary’s exact appointment.\n2. Use the authorized QR verification or Biometric identity screen. QR credentials are issued separately from opening an event; save them during issuance. Never paste raw credentials in ordinary chat.\n3. A live face check needs an enrolled, cleared face profile and active consent. A photo alone is not a verified match. Ask authorized staff about a missing profile or lost credential.\n\nIdentity verification does not record a handover. Event requirements cannot be bypassed.',
    '1. Tingnan ang identity checks ng event at tamang appointment.\n2. Gamitin ang awtorisadong QR verification o Biometric identity screen. Hiwalay ang QR issuance sa pagbubukas ng event; i-save ang credential habang ini-issue. Huwag itong i-paste sa ordinaryong chat.\n3. Kailangan ng enrolled, cleared face profile at active consent para sa live face check. Hindi sapat ang litrato bilang verified match. I-refer ang nawawalang profile o credential sa awtorisadong staff.\n\nHindi handover ang identity verification. Hindi maaaring laktawan ang event requirements.',
    '1. Susiha ang required identity checks sa event ug tukmang appointment.\n2. Gamita ang awtorisadong QR verification o Biometric identity screen. Lahi ang QR issuance sa pag-open sa event; i-save kini panahon sa issuance. Ayaw i-paste ang raw credential sa ordinaryong chat.\n3. Kinahanglan og enrolled, cleared face profile ug active consent ang live face check. Dili pa verified match ang litrato lamang. I-refer sa awtorisadong staff ang missing profile o nawalang credential.\n\nDili handover ang identity verification. Dili malaktawan ang event requirements.',
  ],
  RELEASE: [
    '1. Open Claims and receipts (Releases & receipts for Barangay staff) and select the exact claim.\n2. Complete all required identity checks. The assigned Barangay Facilitator records the actual physical handover, quantity, evidence and acknowledgment.\n3. Issue and reopen the receipt after the release succeeds. Admin and DSWD review records and concerns; they do not replace the facilitator’s physical release role. Confirm representative rules with the responsible office.\n\nA verified identity is not proof of assistance release. No release or receipt was created by this chat.',
    '1. Buksan ang Claims and receipts (Releases & receipts para sa Barangay staff) at piliin ang tamang claim.\n2. Kumpletuhin ang identity checks. Ang nakatalagang Barangay Facilitator ang magtatala ng aktuwal na handover, quantity, evidence at acknowledgment.\n3. Mag-issue at muling buksan ng receipt pagkatapos ng matagumpay na release. Admin at DSWD ang nagrereview ng records at concerns; hindi nila pinapalitan ang physical release role ng facilitator. Kumpirmahin sa opisina ang representative rules.\n\nHindi patunay ng release ang identity verification. Walang release o receipt na ginawa sa chat na ito.',
    '1. Ablihi ang Claims and receipts (Releases & receipts para sa Barangay staff) ug pilia ang tukmang claim.\n2. Kompletoha ang identity checks. Ang assigned Barangay Facilitator motala sa aktuwal nga handover, quantity, evidence ug acknowledgment.\n3. Issue ug ablihi pag-usab ang receipt human molampos ang release. Admin ug DSWD moribyu sa records ug concerns; dili nila pulihan ang physical release role sa facilitator. Kumpirmaha sa opisina ang representative rules.\n\nDili pamatuod sa release ang identity verification. Walay release o receipt nga gihimo niining chat.',
  ],
  MOBILE: [
    'Mobile push delivery is unavailable while the mobile delivery integration is unconnected. A saved push draft is not a delivered notification.\n\nReview mobile account link requests in Beneficiaries using authorized access. An existing person should link to the reviewed record instead of creating a duplicate. A mobile profile picture does not automatically become an enrolled biometric profile. This chat cannot link an account or inspect personal progress.\n\nFor an existing distribution, prepare an SMS reminder and review its actual recipients before confirming.',
    'Hindi pa available ang mobile push delivery habang hindi konektado ang delivery integration. Hindi delivered notification ang saved push draft.\n\nSuriin ang mobile account link requests sa Beneficiaries gamit ang awtorisadong access. I-link ang existing person sa reviewed record upang maiwasan ang duplicate. Hindi awtomatikong enrolled biometric profile ang mobile profile picture. Hindi makakapag-link ng account o makakakita ng personal progress ang chat na ito.\n\nPara sa existing distribution, maghanda ng SMS reminder at suriin ang recipients bago kumpirmahin.',
    'Dili pa available ang mobile push delivery samtang wala pa makonektar ang delivery integration. Dili delivered notification ang saved push draft.\n\nRibyuha ang mobile account link requests sa Beneficiaries gamit ang awtorisadong access. I-link ang existing person sa reviewed record aron malikayan ang duplicate. Dili awtomatikong enrolled biometric profile ang mobile profile picture. Dili maka-link og account o makakita sa personal progress kining chat.\n\nPara sa existing distribution, pag-andam og SMS reminder ug ribyuha ang recipients sa dili pa mokumpirma.',
  ],
  CONCERN: [
    'Use the exact claim’s concern/dispute workflow or Help cases within your authorized scope. Record the concern without changing the original release or receipt to make it disappear. Independent review and access rules still apply.\n\nDo not paste passwords, OTPs, full identification numbers, raw QR credentials or private documents here. Ask authorized staff for an accessible service arrangement. I have not filed or resolved a concern from this message.',
    'Gamitin ang concern/dispute workflow ng tamang claim o Help cases sa iyong awtorisadong scope. Itala ang concern; huwag baguhin ang original release o receipt upang mawala ito. Kailangan pa rin ang independent review at access rules.\n\nHuwag i-paste dito ang password, OTP, buong ID number, raw QR credential o pribadong dokumento. Humingi sa awtorisadong staff ng accessible service arrangement. Wala pang na-file o na-resolve na concern mula sa mensaheng ito.',
    'Gamita ang concern/dispute workflow sa tukmang claim o Help cases sulod sa imong awtorisadong scope. Itala ang concern; ayaw usba ang original release o receipt aron mawala kini. Mosunod gihapon sa independent review ug access rules.\n\nAyaw i-paste dinhi ang password, OTP, full ID number, raw QR credential o pribadong dokumento. Pangayo sa awtorisadong staff og accessible service arrangement. Wala pay gi-file o gi-resolve nga concern gikan niining mensahe.',
  ],
};

export function staffWorkflowGuidance(intent, language) {
  return STAFF_WORKFLOW_GUIDANCE[intent]?.[{ en: 0, fil: 1, ceb: 2 }[language] ?? 0];
}

const staffOverview = [
  "GarantiyAid tracks assistance from enrollment to receipt.\n\n1. Barangay staff register beneficiaries and submit enrollments for review. An authorized reviewer records the decision.\n2. Admin prepares distribution events and allocates assistance. Authorized staff assign appointments.\n3. Staff complete the event’s required identity checks. The assigned Barangay Facilitator records physical handovers. DSWD staff record simulated wallet credits for wallet events. Staff can then review the recorded outcome and receipt.",
  "Sinusubaybayan ng GarantiyAid ang ayuda mula enrollment hanggang resibo.\n\n1. Nirerehistro ng Barangay staff ang beneficiaries at isinusumite ang enrollments. Ang awtorisadong reviewer ang nagtatala ng desisyon.\n2. Inihahanda ng Admin ang distribution event at allocation. Ang awtorisadong staff ang nagtatakda ng appointment.\n3. Kinukumpleto ng staff ang identity checks ng event. Itinatala ng nakatalagang Barangay Facilitator ang handover. Para sa wallet events, DSWD staff ang nagtatala ng simulated credit. Makikita ng staff ang resulta at resibo pagkatapos.",
  "Ang GarantiyAid nagsubay sa ayuda gikan sa enrollment hangtod sa resibo.\n\n1. Ang Barangay staff mo-register sa beneficiaries ug mo-submit sa enrollments. Ang awtorisadong reviewer motala sa desisyon.\n2. Ang Admin moandam sa distribution event ug allocation. Ang awtorisadong staff mo-assign sa appointment.\n3. Kompletohon sa staff ang required identity checks sa event. Ang assigned Barangay Facilitator motala sa physical handover. Sa wallet events, DSWD staff ang motala sa simulated credit. Dayon masusi sa staff ang resulta ug resibo.",
];

const staffStart = {
  SYSTEM_ADMIN: [
    "Start in **Assistance programs** or **Distribution events**. Open **Reports** to review distribution activity and export records.",
    "Magsimula sa **Assistance programs** o **Distribution events**. Sa **Reports** makikita ang distribution activity at mga export.",
    "Sugdi sa **Assistance programs** o **Distribution events**. Ablihi ang **Reports** para makita ang distribution activity ug ma-export ang records.",
  ],
  DSWD_STAFF: [
    "Start in **Enrollment review** for submissions, **Live monitoring** for distributions, or **Reports** for analysis and exports.",
    "Buksan ang **Enrollment review** para sa submissions, **Live monitoring** para sa distributions, o **Reports** para sa pagsusuri at exports.",
    "Ablihi ang **Enrollment review** para sa submissions, **Live monitoring** para sa distributions, o **Reports** para sa analysis ug exports.",
  ],
  BARANGAY_FACILITATOR: [
    "Start in **Beneficiaries**, **Queue & schedules**, or **Releases & receipts** for your assigned barangay.",
    "Magsimula sa **Beneficiaries**, **Queue & schedules**, o **Releases & receipts** para sa nakatalaga mong barangay.",
    "Sugdi sa **Beneficiaries**, **Queue & schedules**, o **Releases & receipts** sa imong assigned barangay.",
  ],
};

const reportGuidance = [
  "1. Open **Reports**. The distribution status report shows authorized event totals.\n2. For details, choose a report type and event. Apply the relevant filters, then select **Generate report**.\n3. **Download report PDF** uses the generated report’s coverage. A **full-event CSV** covers the selected event. **Explain with AI** summarizes the report’s figures.",
  "1. Buksan ang **Reports** para makita ang totals ng awtorisadong distribution events.\n2. Piliin ang report type at event. Ilagay ang filters, pagkatapos piliin ang **Generate report**.\n3. Sakop ng **Download report PDF** ang generated report. Sakop ng **full-event CSV** ang napiling event. Ipinapaliwanag ng **Explain with AI** ang mga numero sa report.",
  "1. Ablihi ang **Reports** para makita ang totals sa awtorisadong distribution events.\n2. Pilia ang report type ug event, i-apply ang filters, dayon pilia ang **Generate report**.\n3. Ang **Download report PDF** mosunod sa scope sa generated report. Ang **full-event CSV** para sa napiling event. Ang **Explain with AI** mopasabot sa figures sa report.",
];

const scheduleGuidance = {
  SYSTEM_ADMIN: [
    "Open **Distribution events** and choose a draft. Confirm the program, allocations, sessions, and slot capacity. **Generate AI draft** proposes assignments for you to review and edit. **Confirm and save draft schedule** saves the appointments. Opening the event is a separate action. Move existing appointments separately. A cancelled appointment must be reactivated separately.",
    "Sa **Distribution events**, piliin ang draft at suriin ang programa, allocations, sessions at capacity. Nagmumungkahi ng assignments ang **Generate AI draft**. Suriin at ayusin ang proposal, pagkatapos piliin ang **Confirm and save draft schedule**. Hiwalay ang pagbubukas ng event at paglipat o pag-reactivate ng appointment.",
    "Sa **Distribution events**, pilia ang draft ug susiha ang program, allocations, sessions ug capacity. Ang **Generate AI draft** mohatag og proposal. Ribyuha ug usba kung kinahanglan, dayon pilia ang **Confirm and save draft schedule**. Lahi ang pag-open sa event ug pagbalhin o pag-reactivate sa appointment.",
  ],
  DSWD_STAFF: [
    "Open **Live monitoring** and select a distribution to review appointments, check-ins, and missed schedules. Use **Reports** for a filtered queue report. Send scheduling corrections to Admin or authorized barangay scheduling staff.",
    "Sa **Live monitoring**, piliin ang distribution para suriin ang appointments, check-ins at missed schedules. Gamitin ang **Reports** para sa filtered queue report. Ipaabot ang mga correction sa Admin o awtorisadong barangay scheduling staff.",
    "Sa **Live monitoring**, pilia ang distribution para masusi ang appointments, check-ins ug missed schedules. Gamita ang **Reports** para sa filtered queue report. Ipaabot ang corrections sa Admin o awtorisadong barangay scheduling staff.",
  ],
  BARANGAY_FACILITATOR: [
    "Open **Queue & schedules** for your assigned barangay and select the event. For a draft event, check session capacity and review any assignments from **Generate AI draft**. Use **Confirm and save draft schedule** after review. Admin handles opening the event. Use the event’s appointment controls to review any moves or reactivations.",
    "Sa **Queue & schedules**, piliin ang event ng iyong barangay. Para sa draft, suriin ang session capacity at assignments mula sa **Generate AI draft** bago piliin ang **Confirm and save draft schedule**. Admin ang nagbubukas ng event. Gamitin ang appointment controls para sa paglipat o pag-reactivate.",
    "Sa **Queue & schedules**, pilia ang event sa imong barangay. Para sa draft, susiha ang session capacity ug proposal gikan sa **Generate AI draft** una mopili sa **Confirm and save draft schedule**. Admin ang mo-open sa event. Gamita ang appointment controls para sa pagbalhin o pag-reactivate.",
  ],
};

const afterCheckIn = [
  "After check-in, complete every identity check required for that event. The assigned Barangay Facilitator records a physical handover, or authorized DSWD staff record the simulated wallet credit for a wallet event. The receipt follows the recorded completion.",
  "Pagkatapos ng check-in, kumpletuhin ang mga identity check na kailangan ng event. Itinatala ng nakatalagang Barangay Facilitator ang physical handover. Para sa wallet event, itinatala ng awtorisadong DSWD staff ang simulated credit. Susunod ang resibo kapag recorded na ang completion.",
  "Human sa check-in, kompletoha ang tanang identity checks nga gikinahanglan sa event. Ang assigned Barangay Facilitator motala sa physical handover. Sa wallet event, ang awtorisadong DSWD staff motala sa simulated credit. Ang resibo mosunod sa natala nga completion.",
];

export function staffScheduleGuidance(language, staffRole) {
  const index = { en: 0, fil: 1, ceb: 2 }[language] ?? 0;
  return Object.hasOwn(scheduleGuidance, staffRole) ? scheduleGuidance[staffRole][index] : undefined;
}

export function staffOverviewGuidance(language, staffRole) {
  const index = { en: 0, fil: 1, ceb: 2 }[language] ?? 0;
  const entryPoints = Object.hasOwn(staffStart, staffRole) ? staffStart[staffRole][index] : undefined;
  return [staffOverview[index], entryPoints].filter(Boolean).join("\n\n");
}

const systemWalkthrough = [
  `### GarantiyAid walkthrough

For your consultation, follow one fictional beneficiary through a physical-assistance event. At each step, show the record that the next staff member will use.

| Step and who handles it | What to do and verify |
| --- | --- |
| **1. Program setup · DSWD staff** | In **Assistance programs**, add the requirements and activate the program. Check that the program is active before enrolling anyone. |
| **2. Enrollment · Barangay Facilitator** | In **Beneficiaries**, search first, then register the person if needed. Upload each required document, choose the active program and select **Submit enrollment**. Keep the enrollment reference for the reviewer. |
| **3. Review · DSWD staff or independent Admin** | In **Enrollment review**, select **Start validation** and review each document and the eligibility result. Check for **Approved** after approving, or record the correction needed before returning the case. |
| **4. Event and queue · Admin** | In **Distribution events**, draft the event, set the package and session capacity, allocate the approved beneficiary and save an appointment. Check the date, slot and beneficiary, then use **Open distribution event**. Issue a QR card separately for an event that uses QR. |
| **5. Verification · Authorized staff** | Select the exact appointment and complete the event’s identity checks. Show the **Checked in** appointment and verified claim. If a required check is pending, use **Continue identity checks** before any handover. |
| **6. Handover and receipt · Barangay Facilitator** | In **Releases & receipts**, record the actual quantity and acknowledgment or evidence reference. Save the release, then select **Issue receipt** and check the details. |
| **7. Reconciliation · Admin** | In **Distribution reconciliation**, compare the handover, receipt and log. Resolve any findings before **Close distribution event**. Show the final status and audit history. |

**What to explain during the demo**

- A different user reviews the enrollment. Admin allocates approved beneficiaries to the event, then schedules them.
- A verified claim is ready for the release workflow. The recorded handover and issued receipt show what happened next.
- For a simulated wallet event, authorized DSWD staff record the simulated credit after verification.`,
  `### Walkthrough ng GarantiyAid

Para sa consultation, sundan ang isang kathang-isip na beneficiary sa isang physical-assistance event. Sa bawat hakbang, ipakita ang record na gagamitin ng susunod na staff.

| Hakbang at responsable | Gawin at suriin |
| --- | --- |
| **1. Programa · DSWD staff** | Sa **Assistance programs**, idagdag ang requirements at i-activate ang programa. Tiyaking aktibo ito bago mag-enroll. |
| **2. Enrollment · Barangay Facilitator** | Sa **Beneficiaries**, hanapin muna ang tao bago mag-register. I-upload ang bawat kailangan na dokumento, piliin ang programa at gamitin ang **Submit enrollment**. Itabi ang enrollment reference para sa reviewer. |
| **3. Review · DSWD staff o independent Admin** | Sa **Enrollment review**, piliin ang **Start validation** at suriin ang bawat dokumento at eligibility result. Tingnan kung **Approved** pagkatapos mag-approve, o itala ang kailangang itama bago ibalik ang case. |
| **4. Event at pila · Admin** | Sa **Distribution events**, gumawa ng draft, itakda ang package at session capacity, i-allocate ang approved beneficiary at i-save ang appointment. Suriin ang petsa, slot at pangalan bago gamitin ang **Open distribution event**. Hiwalay ang pag-issue ng QR card para sa event na gumagamit ng QR. |
| **5. Verification · Awtorisadong staff** | Piliin ang tamang appointment at kumpletuhin ang identity checks ng event. Ipakita ang **Checked in** na appointment at verified claim. Kung may pending na check, gamitin ang **Continue identity checks** bago ang handover. |
| **6. Handover at resibo · Barangay Facilitator** | Sa **Releases & receipts**, itala ang aktuwal na dami at acknowledgment o evidence reference. I-save ang release, piliin ang **Issue receipt** at suriin ang detalye. |
| **7. Reconciliation · Admin** | Sa **Distribution reconciliation**, ihambing ang handover, resibo at log. Ayusin ang findings bago gamitin ang **Close distribution event**. Ipakita ang final status at audit history. |

**Ipaliwanag sa demo**

- Ibang user ang magre-review ng enrollment. Admin ang nag-a-allocate ng approved beneficiaries sa event bago sila i-schedule.
- Kapag verified ang claim, maaari nang simulan ang release workflow. Ang handover record at resibo ang magpapakita ng kinalabasan.
- Para sa simulated wallet event, ang awtorisadong DSWD staff ang nagtatala ng simulated credit pagkatapos ng verification.`,
  `### Walkthrough sa GarantiyAid

Para sa consultation, sunda ang usa ka hinimo nga beneficiary sa physical-assistance event. Sa matag lakang, ipakita ang record nga gamiton sa sunod nga staff.

| Lakang ug responsable | Buhaton ug susihon |
| --- | --- |
| **1. Programa · DSWD staff** | Sa **Assistance programs**, idugang ang requirements ug i-activate ang programa. Susiha nga active kini una mag-enroll. |
| **2. Enrollment · Barangay Facilitator** | Sa **Beneficiaries**, pangitaa una ang tawo sa dili pa mag-register. I-upload ang matag required document, pilia ang programa ug gamita ang **Submit enrollment**. Tipigi ang enrollment reference para sa reviewer. |
| **3. Review · DSWD staff o independent Admin** | Sa **Enrollment review**, pilia ang **Start validation** ug susiha ang matag dokumento ug eligibility result. Susiha ang **Approved** nga status human mo-approve, o itala ang angay tul-iron una ibalik ang case. |
| **4. Event ug pila · Admin** | Sa **Distribution events**, paghimo og draft, itakda ang package ug session capacity, i-allocate ang approved beneficiary ug i-save ang appointment. Susiha ang petsa, slot ug tawo una mopili sa **Open distribution event**. Lahi ang pag-issue og QR card para sa event nga naggamit og QR. |
| **5. Verification · Awtorisadong staff** | Pilia ang tukmang appointment ug kompletoha ang identity checks sa event. Ipakita ang **Checked in** nga appointment ug verified claim. Kung naa pay pending nga check, gamita ang **Continue identity checks** una itunol ang ayuda. |
| **6. Handover ug resibo · Barangay Facilitator** | Sa **Releases & receipts**, itala ang aktuwal nga gidaghanon ug acknowledgment o evidence reference. I-save ang release, pilia ang **Issue receipt** ug susiha ang detalye. |
| **7. Reconciliation · Admin** | Sa **Distribution reconciliation**, itandi ang handover, resibo ug log. Sulbara ang findings una mopili sa **Close distribution event**. Ipakita ang kataposang status ug audit history. |

**Ipasabot panahon sa demo**

- Lain nga user ang mo-review sa enrollment. Ang Admin mo-allocate sa approved beneficiaries sa event una sila i-schedule.
- Kung verified na ang claim, puwede nang sugdan ang release workflow. Ang handover record ug resibo magpakita sa nahitabo.
- Sa simulated wallet event, ang awtorisadong DSWD staff motala sa simulated credit human sa verification.`,
];

const fullSystemFlow = /\b(?:(?:flow|workflow|walkthrough|process|proseso|daloy) (?:of|for|sa|ng) (?:garantiyaid|(?:this|the|whole) (?:system|app)|sistemang ito|kini nga system)|(?:garantiyaid|system) (?:flow|workflow|walkthrough)|(?:from|gikan sa|mula) enrollment (?:to|hangtod|hanggang)(?: sa)? (?:receipt|release|resibo))\b/;
const stepByStep = /\b(?:step by step|in detail|in a table|walk me through|hakbang hakbang|matag lakang|tagsa tagsa)\b/;
const detailFollowUp = /^(?:(?:please|can you|could you|palihog|paki) )*(?:(?:explain|show|walk me through)(?: (?:it|that|more))?(?: (?:step by step|in detail))?|(?:show|make|put) (?:it|that) (?:as|in|into) a table|make (?:it|that) a table|ipasabot pa|ipaliwanag pa)$/;

const administration = {
  en: {
    open: "As a System Administrator, open **Administration → Staff and barangays** in the sidebar.",
    barangays: "Under **Barangays**, select **Add barangay**. Enter the city or municipality, province and official barangay name, then select **Register barangay**. If a new facilitator will serve this barangay, register it first.",
    staff: "Under **Staff accounts**, select **Create staff account**. Choose **DSWD Staff** or **Barangay Facilitator** and enter the full name and official email. For a facilitator, enter a username and select an active barangay. Create the account, then give the staff member their generated Staff ID and temporary password privately.",
    restricted: "Ask your System Administrator to create the staff account or register the barangay under **Administration → Staff and barangays**. That screen requires a System Administrator account.",
  },
  ceb: {
    open: "Ablihi ang **Administration → Staff and barangays** sa sidebar.",
    barangays: "Sa **Barangays**, pilia ang **Add barangay**. Isulod ang siyudad o munisipyo, probinsya ug opisyal nga ngalan sa barangay. Pilia ang **Register barangay**. Kung dinhi i-assign ang bag-ong facilitator, irehistro una ang barangay.",
    staff: "Sa **Staff accounts**, pilia ang **Create staff account**. Pilia ang **DSWD Staff** o **Barangay Facilitator**, dayon isulod ang kompletong ngalan ug opisyal nga email. Para sa facilitator, isulod pud ang username ug pilia ang aktibong barangay nga iyang serbisyohan. Human mahimo ang account, ihatag sa staff sa pribado ang iyang Staff ID ug temporary password.",
    restricted: "Ang System Administrator ang makahimo og staff account o makarehistro og barangay sa **Administration → Staff and barangays**. Hangyoa ang inyong admin nga moasikaso niini.",
  },
  fil: {
    open: "Buksan ang **Administration → Staff and barangays** sa sidebar.",
    barangays: "Sa **Barangays**, piliin ang **Add barangay**. Ilagay ang lungsod o munisipalidad, lalawigan at opisyal na pangalan ng barangay, pagkatapos piliin ang **Register barangay**. Kung dito itatalaga ang bagong facilitator, irehistro muna ang barangay.",
    staff: "Sa **Staff accounts**, piliin ang **Create staff account**. Piliin ang **DSWD Staff** o **Barangay Facilitator** at ilagay ang buong pangalan at opisyal na email. Para sa facilitator, maglagay din ng username at pumili ng aktibong barangay. Pagkagawa ng account, pribadong ibigay sa kawani ang kanyang Staff ID at pansamantalang password.",
    restricted: "Hilingin sa inyong System Administrator na gumawa ng staff account o magrehistro ng barangay sa **Administration → Staff and barangays**. Para sa System Administrator ang screen na ito.",
  },
};

export function staffAdministrationGuidance(language, staffRole, { staff = true, barangays = true } = {}) {
  const copy = administration[language] ?? administration.en;
  if (staffRole !== "SYSTEM_ADMIN") return copy.restricted;
  return [copy.open, barangays && copy.barangays, staff && copy.staff].filter(Boolean).join("\n\n");
}

const setupVerb = /\b(?:creat(?:e|es|ed|ing)|add(?:s|ed|ing)?|register(?:ing)?|set up|setup|make|find|open|(?:mag|pag|mo|maka)?himo|(?:mag|pag)?buhat|(?:mag|pag)?dugang|(?:mag|pag)?dagdag|gumawa|(?:i|mag)?rehistro)\s+(?:(?:a|an|the|new|another|og|ug|sa|ang|mga|ng|bagong|bag o|nga|na) )*/g;
const staffObject = /^(?:(?:dswd(?: and barangay)?|barangay) (?:staff|facilitators?|accounts?)|staff(?: accounts?)?|accounts? (?:for|para (?:sa|ng)|sa|ng) (?:the |a |mga )?(?:dswd|barangay|staff))\b/;
const barangayObject = /^(?:barangays?|brgys?)\b(?! (?:staff|facilitators?|accounts?|beneficiar(?:y|ies)|residents?|enrollments?|events?|reports?)\b)/;

function administrationTopics(question) {
  const objects = Array.from(question.matchAll(setupVerb), match => question.slice(match.index + match[0].length));
  const staff = objects.some(object => staffObject.test(object)) || /\bstaff account (?:creation|setup)\b/.test(question);
  const barangays = objects.some(object => barangayObject.test(object)) || /\bbarangay registration\b/.test(question)
    || (staff && /\b(?:and|ug|at) (?:the |mga )?barangays?\b(?:$| (?:too|also|pud|rin)$)/.test(question));
  if (staff || barangays) return { staff, barangays };
}

const roleQualifier = /\b(?:as|for|isip|bilang) (?:an? |the |usa ka |isang )?(?:system admin(?:istrator)?|admin(?:istrator)?|dswd staff|barangay facilitator)\b/;
const adminSteps = [
  "1. In **Enrollment review**, check the decision for each application. Only approved beneficiaries can be allocated.\n2. Open **Distribution events**, create a draft, and set the package, sessions and capacity.\n3. Allocate the approved beneficiaries and review their appointments. Select **Confirm and save draft schedule** if you used the AI draft.\n4. Check the date and queue, then select **Open distribution event**. Issue QR cards if the event requires them.\n5. After staff record verification and handover, open **Distribution reconciliation**. Match releases to receipts and resolve findings before closing the event.",
  "1. Sa **Enrollment review**, suriin ang desisyon sa bawat application. Ang mga aprubadong beneficiary ang puwedeng i-allocate.\n2. Sa **Distribution events**, gumawa ng draft at itakda ang package, sessions at capacity.\n3. I-allocate ang mga aprubadong beneficiary at suriin ang appointments. Kung gumamit ng AI draft, piliin ang **Confirm and save draft schedule**.\n4. Suriin ang petsa at pila bago piliin ang **Open distribution event**. Mag-issue ng QR cards kung kailangan.\n5. Pagkatapos maitala ng staff ang verification at handover, buksan ang **Distribution reconciliation**. Itugma ang releases at resibo at lutasin ang findings bago isara ang event.",
  "1. Sa **Enrollment review**, susiha ang desisyon sa matag application. Ang mga approved nga beneficiary ang puwedeng i-allocate.\n2. Sa **Distribution events**, paghimo og draft ug itakda ang package, sessions ug capacity.\n3. I-allocate ang approved nga beneficiaries ug ribyuha ang ilang appointments. Kung migamit ka og AI draft, pilia ang **Confirm and save draft schedule**.\n4. Susiha ang petsa ug pila una mopili sa **Open distribution event**. Pag-issue og QR cards kung gikinahanglan.\n5. Human matala sa staff ang verification ug handover, ablihi ang **Distribution reconciliation**. Itandi ang releases sa mga resibo ug sulbara ang findings una isira ang event.",
];

function asksForRoleGuide(question) {
  if (!roleQualifier.test(question)) return false;
  const topic = question.replace(roleQualifier, "").replace(stepByStep, "").replace(/\s+/g, " ").trim();
  return !topic || isSystemOverviewQuestion(topic) || /^(?:how (?:does )?(?:this|it) works?|what (?:do|should) i do|unsaon (?:ni|nako)|paano (?:ito|gamitin ito))$/.test(topic);
}

function asksForSystemWalkthrough(question) {
  return fullSystemFlow.test(question) || (stepByStep.test(question) && isSystemOverviewQuestion(question
    .replace(stepByStep, " ").replace(/\s+/g, " ").trim()
    .replace(/ for (?:my |a |the )?consultation$/, "")));
}

export function staffSystemWalkthrough({ intent, language, messageText, history, staffRole }) {
  if (!["HELP", "SCHEDULE", "BENEFICIARY", "DOCUMENT_REQUIREMENTS", "ENROLLMENT", "IDENTITY", "RELEASE"].includes(intent)) return undefined;
  const question = normalizeChatbotText(messageText);
  const followUp = text => detailFollowUp.test(text) || /^(?:what next|and then|continue|where do i go|unya|dayon|unsa(?:y| ang)? sunod|ano ang susunod)$/.test(text);
  const previousQuestion = followUp(question)
    ? history.findLast(message => message.role === "user" && !followUp(normalizeChatbotText(message.content)))?.content
    : undefined;
  if (["HELP", "BENEFICIARY", "DOCUMENT_REQUIREMENTS"].includes(intent)) {
    let topics = administrationTopics(normalizeChatbotText(previousQuestion ?? messageText));
    if (!topics && /^(?:what about|how about|and|unya ang|paano naman ang) (?:the )?(barangays?|staff accounts?)$/.test(question)) {
      const lastQuestion = history.findLast(message => message.role === "user")?.content;
      if (lastQuestion && administrationTopics(normalizeChatbotText(lastQuestion))) {
        topics = { staff: question.includes("staff"), barangays: question.includes("barangay") };
      }
    }
    if (topics) return staffAdministrationGuidance(language, staffRole, topics);
  }
  if (asksForRoleGuide(question) || (previousQuestion && asksForRoleGuide(normalizeChatbotText(previousQuestion)))) {
    if (staffRole !== "SYSTEM_ADMIN") return staffOverviewGuidance(language, staffRole);
    const setup = (administration[language] ?? administration.en).open;
    return setup + "\n\n" + adminSteps[{ en: 0, fil: 1, ceb: 2 }[language] ?? 0];
  }
  if (asksForSystemWalkthrough(question) || (previousQuestion && (
    isSystemOverviewQuestion(previousQuestion) || asksForSystemWalkthrough(normalizeChatbotText(previousQuestion))
  ))) {
    return systemWalkthrough[{ en: 0, fil: 1, ceb: 2 }[language] ?? 0];
  }
}

export function staffNavigationGuidance({ intent, language, messageText, staffRole }) {
  if (!["HELP", "SCHEDULE", "BENEFICIARY"].includes(intent)) return undefined;
  if (intent === "HELP" && isSystemOverviewQuestion(messageText)) {
    return staffOverviewGuidance(language, staffRole);
  }
  const question = normalizeChatbotText(messageText);
  const index = { en: 0, fil: 1, ceb: 2 }[language] ?? 0;
  if (/\b(?:check in|checked in)\b/.test(question) && /\b(?:after|next|sunod|human sa|pagkatapos)\b/.test(question)) {
    return afterCheckIn[index];
  }
  if (intent === "BENEFICIARY") return undefined;
  const asksForReport = /\b(?:reports?|ulat)\b/.test(question)
    && /\b(?:find|open|generate|download|view|use|where|asa|saan|paano|unsaon|tan aw|makita)\b/.test(question);
  if (!asksForReport) return intent === "SCHEDULE" ? staffScheduleGuidance(language, staffRole) : undefined;
  if (staffRole === "SYSTEM_ADMIN" || staffRole === "DSWD_STAFF") return reportGuidance[index];
  return staffRole === "BARANGAY_FACILITATOR" ? staffStart[staffRole][index] : undefined;
}
