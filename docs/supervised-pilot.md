# Supervised pilot and handover

Current scope, confirmed 5 November 2026: **prepare and rehearse locally with synthetic data**. There are no supplied deployed URLs, named supervisor or available government testers. The automated rehearsal is evidence of software behavior; it does not fill the staff acceptance or office approval fields below.

Use the existing [staff workflow](../../garantiyaid-frontend/docs/staff-workflow.md) and copy the [session record](pilot-session-template.md) for each observed session. The application already records claims, receipts, disputes, reconciliation and closure. These sheets record observations and acceptance alongside that evidence; they do not authorize a release or change a database record.

## 1. Prepare the session

For the local rehearsal, use the disposable test runner:

```powershell
cd garantiyaid-backend
npm.cmd run verify:pilot
```

It starts the real API, browser and isolated PostgreSQL instance, uses separate synthetic role accounts, then removes its own databases. Require exit 0, `passed`, `databaseRemoved` and `recoveryDatabaseRemoved` in `../output/pilot-acceptance/results.json`. Copy the results and screenshots into that session's evidence folder before another run replaces them. No persistent demo passwords are created. The runner simulates face processing, wallet settlement and SMS; it does not contact beneficiaries or move funds.

For a later **observed staff session**, use a separate demonstration/staging environment and the normal [setup](../README.md) / [deployment guide](pilot-deployment.md). Do not load synthetic beneficiaries into an operational database. The temporary runner accounts disappear after the automated run and are not staff onboarding accounts.

Before an actual pilot, the supervisor records:

- Selected office, service, participating barangays, date, duration and participant limit.
- Named Barangay, DSWD and Admin users, an observer, accountable supervisor and technical/support contact. Reviewers must remain independent of the submission or concern they decide. The observer should let each staff member attempt the task before coaching.
- Accepted [government procedure](government-procedure-review.md) and [privacy/operations review](pilot-review.md), including exceptions and the real notification channel.
- Actual frontend/API URLs and release identifiers; passing deployed preflight; accepted backup/restore, monitoring and persistent-volume checks.
- Specific camera/scanner/printer/browser/network to use, accessible verification/acknowledgment procedure and custody of paper evidence.

Keep the approval references in the session record; retain signed originals through the office's records process. A local test result or checked box is not official authorization. When these prerequisites are missing, remain in synthetic rehearsal and mark actual pilot acceptance **NOT RUN**.

## 2. Walk the staff journey

Start with the physical-assistance branch and a small synthetic dataset. Use separate fictional people for the normal journey, document correction, held claim and handover discrepancy. Use the same person only when intentionally testing repeated submission. Do not use real identity documents as sample uploads.

| Scenario | Staff action | Observer checks |
| --- | --- | --- |
| S01 — Accounts and area | Each role signs in normally; open an allowed record and a known record from another test barangay | Individual account, correct role/area and denied out-of-area access; record sign-in difficulty without recording passwords/TOTP |
| S02 — Registration and correction | Barangay registers the person, uploads synthetic documents and submits; DSWD returns a correction; Barangay fixes/resubmits; independent reviewer approves | Status, correction note, next role and document list agree; no duplicate person or self-approval |
| S03 — Event and queue | Admin defines the full package and requirements, allocates, schedules and opens; assigned Barangay confirms the visit | Whole-unit package is fixed on opening, correct appointment/event and clear queue; draft/open permissions remain enforced |
| S04 — Verification | Complete only the event's required QR/face/signature steps | Correct person/event, valid consent and no handover while verification is incomplete; simulated face results are identified |
| S05 — Physical completion | Barangay records the actual full package and signed-log reference, then issues/reopens the receipt | One handover, correct actor/time/quantity/reference, original receipt retained; no real goods are used in the automated rehearsal |
| S06 — Lost response and repeat | In the synthetic environment, interrupt a saved response and retry the retained request; have two operators attempt the same completion | One saved completion; original evidence remains; no second handover to compensate for uncertainty |
| S07 — Concern and review | File a synthetic concern, start independent review, attempt completion while held, then resolve with current evidence | Hold blocks release/credit; self-review and stale decisions rejected; refreshed evidence required |
| S08 — Voided handover | Independently remediate a synthetic physical claim after its recorded handover | Recorded handover and quantity remain in reconciliation/report, including voided quantity; issued receipt is historical and unchanged; no return of goods inferred |
| S09 — Simulated wallet | Run the separate wallet branch through verification, simulated credit, receipt and reconciliation | No physical handover required for this branch, no duplicate credit, all amounts reconcile; no real payment claim |
| S10 — Close and report | Admin compares records with the signed test log, resolves exceptions, generates reports and closes | Recipient/claim/receipt mapping explained; original handovers retained; closed-event operations rejected |
| S11 — Recovery | Operator follows the outage/backup procedure in an isolated test environment | Storage/database failure detected; restore evidence matches; old sessions/reset links/recovery codes invalidated; operator reconciles post-backup differences before reopening |
| S12 — Actual devices and accessibility | Staff use their camera/scanner/printer and keyboard/mobile procedure | Record real equipment, capture/mismatch behavior, readable printed references and task completion; mark NOT RUN if hardware/staff are unavailable |

Use the exact screens and exception actions in the staff guide. Missing appointments, failed biometrics, representatives, partial packages and outages must follow the approved referral/continuity procedure. Do not improvise a manual verification override or edit database rows to make the session pass. Test power/network interruption only in the agreed test environment; do not interrupt an operational handover.

## 3. Observe, log issues and retest

Record task start/end, queue arrival/service-start, attempts and assistance needed for each observed task. A blank time is unknown, not zero. Keep automated timings separate from human task timings. At debrief, ask staff to explain the next responsible role and what they would do after an uncertain response.

Use the session record's issue rows. Record expected/actual behavior, role, scenario and restricted evidence reference. Do not include beneficiary names, identity documents, signatures, raw face data, credentials or reset links in ordinary issue reports. Reproduction data and screenshots committed to source must be synthetic or redacted.

- **Stop immediately:** unauthorized access, wrong-person/duplicate completion, lost or changed original evidence, unexplained quantity/ledger difference, or unusable core verification/release/receipt flow. Pause the affected activity, preserve evidence and notify the named supervisor/incident lead through the agreed channel. Do not resolve the problem by repeating the physical handover.
- **Other defect or confusion:** assign an owner, define the expected fix, and identify affected staff steps. A cosmetic issue may be accepted only with a recorded owner-approved limitation; an unsafe or unusable core task cannot be waived into success.
- **Retest:** reproduce with synthetic data, fix the existing flow, run the relevant regression plus affected end-to-end steps, and let the original staff role try again. Record release, tester, date and evidence. A developer's “fixed” label is not a passed staff retest.

Keep the failed attempt and its retest linked; do not overwrite the first observation. Repeated or reopened failures remain unresolved until verified.

## 4. Reconcile each event

Use **Distribution reconciliation**, **Reports and audit**, each exact claim and the original signed log. The screen's “Reconciled” state covers recorded system checks; the supervisor still verifies physical evidence.

1. Match every signed-log row to the event, recipient/claim, actual package units, releasing staff and receipt/reference. Investigate unmatched or duplicate rows individually; matching totals alone can conceal a wrong recipient.
2. Compare **Recorded handovers** and **Recorded handover/package units** with the log. These include original handovers on voided claims. **Value of completed claims** excludes voided claims and is not a stock balance or proof of money movement.
3. Review **Units on voided claims** and **Handovers without quantity**. Unknown historical quantities stay unknown; do not invent them from the current package. A void is not a return, and no warehouse inventory/returns accounting is implemented.
4. Match issued receipts, including historical receipts retained after a void, to their claims. Explain each difference rather than forcing receipt count to equal current completed-claim count. Record outstanding concerns, visits and missing receipts.
5. For the simulated wallet branch, compare expected credit, completed/reversed credits and net credit separately. Do not combine simulated peso amounts with physical package units.
6. Close only after the system permits closure and the accountable supervisor accepts the event's reconciliation. Admin retains the closing-sheet/log reference in the closure note. Preserve the original closure record.

## 5. Decide and hand over

The supervisor records **NOT RUN**, **CONTINUE WITH FIXES** or **ACCEPTED FOR THE RECORDED SCOPE**, with date, position and retained approval reference. Acceptance needs actual authorized staff/device results for the selected scope, accepted Batch 4/5 prerequisites, explained reconciliation, and no unresolved defect affecting authorization, evidence, quantities or core task completion.

Hand over the existing staff guide, named access/account-recovery ownership, support/escalation contacts, deployment/release inventory, backup/restore custody and schedule, monitoring responsibilities and accepted limitations. Transfer secrets through the approved secret store, never these sheets. Remove temporary demonstration access through normal account deactivation and test session revocation. Preserve required evidence under the agreed retention policy; do not reset the pilot database.

Current limitations stay explicit: no actual SMS delivery or payment settlement, no approved representative/partial-release/stock-return workflow, no offline handover import, and no assumed camera calibration or government approval. Expansion beyond the recorded scope needs another acceptance session.
