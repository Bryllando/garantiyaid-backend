# Supervised pilot session record — blank template

Copy into the office-approved restricted record location. **Default outcome: NOT RUN.** Keep real-person details and secrets out of the source repository. Link restricted evidence by reference; use synthetic aliases in demonstration records. See the [session guide](supervised-pilot.md) and existing [staff steps](../../garantiyaid-frontend/docs/staff-workflow.md).

## Session and responsibility

| Field | Recorded value |
| --- | --- |
| Session ID / date / time zone / location | Pending |
| Type: automated synthetic / observed synthetic / approved real-person pilot | Pending |
| Office / service / barangays / participant limit / duration | Pending |
| Frontend/API URLs; frontend/backend release IDs | Pending |
| Supervisor and accountable position | Pending |
| Barangay / DSWD / Admin testers (named individual accounts) | Pending |
| Observer / technical operator / support and incident contact | Pending |
| Camera / scanner / printer / browser / network | Pending |
| Scenarios in scope; excluded scenarios and reason | Pending |
| Evidence location and custodian | Pending |

## Entry decision

For automated/observed synthetic rehearsal, explicitly mark real-person approvals as pending. For an actual pilot, attach accepted decisions from the existing review records; do not treat this table as a replacement for them.

| Prerequisite | Result / date / retained reference / owner |
| --- | --- |
| Government procedure, roles, package/log format and exceptions accepted | Pending |
| Privacy, retention, providers, accessibility and participant scope accepted | Pending |
| Deployed preflight, TLS/proxy and restricted accounts/DB role verified | Pending |
| Private volume, malware handling and storage survival verified | Pending |
| Separate backup/restore, keys, schedule, RPO/RTO and monitoring accepted | Pending |
| Staff/device availability, support and stop procedure confirmed | Pending |
| Entry decision: SYNTHETIC ONLY / READY FOR APPROVED PILOT / POSTPONED | Pending |
| Supervisor / date / approval reference | Pending |

## Scenario results

Use **PASS / FAIL / BLOCKED / NOT RUN**. PASS requires actual evidence for that scenario and scope. Automated PASS does not imply staff/hardware PASS. Record any excluded scenario with its reason and supervisor's decision; never silently drop it.

| Scenario | Test type / role / device | Result | Evidence / issue / observer / date |
| --- | --- | --- | --- |
| S01 Accounts and area | Pending | NOT RUN | Pending |
| S02 Registration, correction and independent approval | Pending | NOT RUN | Pending |
| S03 Event, full package and queue | Pending | NOT RUN | Pending |
| S04 Required verification | Pending | NOT RUN | Pending |
| S05 Physical handover and receipt | Pending | NOT RUN | Pending |
| S06 Lost response, retry and competing operators | Pending | NOT RUN | Pending |
| S07 Concern, independent review and stale evidence | Pending | NOT RUN | Pending |
| S08 Voided handover and historical receipt | Pending | NOT RUN | Pending |
| S09 Simulated wallet and reversal reconciliation | Pending | NOT RUN | Pending |
| S10 Reports, log comparison and closure | Pending | NOT RUN | Pending |
| S11 Outage, restore and recovery access | Pending | NOT RUN | Pending |
| S12 Actual devices, printing and accessibility | Pending | NOT RUN | Pending |

## Observation rows — add one per attempt

| Observation ID / scenario | Staff role / synthetic case alias | Arrival / service start / task start / end, with time zone | Attempts / coaching / scan failures | Expected / actual / outcome / evidence reference |
| --- | --- | --- | --- | --- |
| Pending | Pending | Pending; blank means unmeasured | Pending | Pending |

Compute queue wait as service-start minus arrival and task duration as end minus task-start only when both are recorded. Summarize number attempted/completed, delays, repeated submissions, corrections, scan failures and staff confusion. Do not replace observations with a single average or automated run time.

## Issue and retest rows

| Issue / observation IDs | Severity and affected task | Expected / actual / safe reproduction | Owner / status / planned action | Fix release / retest role / date / result / evidence |
| --- | --- | --- | --- | --- |
| Pending | Pending | Pending | Pending | NOT RUN |

Severity: **STOP** for unauthorized/wrong/duplicate completion, lost evidence, unexplained reconciliation or unusable core tasks; **WORKFLOW** for other functional/usability defects; **COSMETIC** for presentation with no task/data impact. Status: OPEN / FIXED-AWAITING-RETEST / RETEST-PASSED / REOPENED / ACCEPTED-LIMITATION. Accepted limitations require supervisor, rationale, owner and review date; never use them to waive STOP issues.

For a stop: record time, affected scope, preserved evidence, notified contact, containment and authorized restart decision. No passwords, tokens, raw face captures or identity documents in these rows.

## Event closing sheet — repeat for each event

| Item | System value / signed-log value / difference / evidence reference |
| --- | --- |
| Event ID / delivery mode / package name and unit | Pending |
| Per-recipient claim ↔ original log ↔ receipt mapping reviewed | Pending |
| Recorded handovers, including voided claims | Pending |
| Recorded package units, including voided claims | Pending |
| Units on voided claims; no return inferred | Pending |
| Handovers with unknown quantity and disposition | Pending |
| Completed claims and their value; voids excluded from this value | Pending |
| Issued receipts, including historical receipts retained after voids | Pending |
| Missed/unresolved visits, holds, concerns and missing receipts | Pending |
| Wallet branch only: expected / gross / reversed / net simulated credit | Pending / not applicable with reason |
| Every unmatched/duplicate record or difference: cause, issue, owner and resolution | Pending |
| System ready-to-close result and timestamp | Pending |
| Supervisor reconciliation decision / date / retained reference | Pending |
| Admin closure note/reference / timestamp; preserved after retry | Pending |

## Handover and final decision

| Item | Responsible person / acknowledgment / date / reference |
| --- | --- |
| Staff guide and accepted normal/exception procedure | Pending |
| Named access ownership, offboarding and verified recovery | Pending |
| Support, escalation and incident contacts | Pending |
| Exact release/configuration inventory; secret custody confirmed separately | Pending |
| Backup destination/key custody/schedule/restore operator | Pending |
| Monitoring, failed-job/backup alerts and response ownership | Pending |
| Outstanding limitations with scope, owner and review date | Pending |
| Required records preserved; demonstration access deactivated and tested | Pending |

- Actual staff/device acceptance: **NOT RUN**
- Event reconciliation accepted by process owner: **NOT RUN**
- Required fixes retested: **NOT RUN**
- Final outcome: **NOT RUN**
- Supervisor / position / date / signed decision reference: **Pending**

Choose CONTINUE WITH FIXES when required cases, operational prerequisites or evidence are incomplete. Use ACCEPTED FOR THE RECORDED SCOPE only after the acceptance conditions in the session guide are met. This document itself grants no government authority and changes no application permissions.
