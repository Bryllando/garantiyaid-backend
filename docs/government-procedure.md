# Government procedure and physical-assistance handover

Prepared 5 November 2026 for the proposed Cebu City capstone scope. The partner office, specific barangays, named program and approving process owner are **not yet selected**. This document describes the implemented system and a procedure for office review. It does not establish an official Cebu City or DSWD procedure.

## Recommended accountability model

Use **package quantities plus a signed release-log reference**. They answer different questions:

| Record | What it establishes |
| --- | --- |
| Event package | What each eligible beneficiary is scheduled to receive: a named item or standard package, whole-unit quantity and unit label. |
| Claim handover | What staff recorded as handed over, by whom and when. The package name and unit are copied into the release record. |
| Signed log / acknowledgment reference | Where to find the beneficiary's acknowledgment and the office's supporting evidence. Use a traceable entry, such as log identifier, page and row. |
| System receipt | The original completed-claim snapshot, including the package and evidence reference. It does not replace whatever acknowledgment or accounting form the office requires. |
| Reconciliation and report | Recorded package units, units on voided claims and older handovers without quantities, alongside claim and financial totals. |

Example for synthetic testing: `Family food pack`, unit `pack`, quantity `1`, evidence reference `DEMO-LOG-01 / page 3 / row 12`. This is an example, not an approved government entitlement.

The minimal implementation supports one item or standard package per event and whole units from 1 to 10,000 per beneficiary. A package may contain multiple goods documented in the office's package specification or release log. It is not a warehouse inventory, procurement, stock-return or individual package-component ledger. Different packages, partial installments, substitutions, variable beneficiary entitlements and fractional quantities need a separately agreed procedure before implementation.

## Staff steps

1. The process owner selects the service, identifies the responsible officers and supplies its current requirements. Record the decisions in the [office review record](government-procedure-review.md). Configure only those program requirements and identity checks approved for that service.
2. Barangay registers the beneficiary in its assigned area and submits readable supporting documents and enrollment. An authorized independent reviewer decides enrollment. Program approval, event allocation and actual receipt of goods remain separate facts.
3. Admin creates a physical-assistance event and enters **Package or item name**, **Unit**, and **Quantity per beneficiary**. Prepare sessions, allocations and appointments. For a draft with existing sessions, use **Open event > Edit assistance package**; this edits only package fields.
4. Review the package, eligible recipients, capacity and schedule, then open the event. The server rejects opening a physical event without a package. Package details cannot be edited after opening.
5. Assigned verification staff complete the event-required identity checks for the same beneficiary. Pending verification, an active dispute or a duplicate hold prevents release.
6. Barangay confirms the full package is available, completes the handover, obtains acknowledgment and records **Quantity handed over**, evidence type and exact evidence reference. Missing, smaller or larger quantities cannot mark the claim complete. An uncertain saved response must be retried using the retained request; inspect the existing claim before handing out anything again.
7. Issue and review the system receipt. Verify the named beneficiary, package, quantity, staff, timestamp and evidence reference. Retain the original signed acknowledgment using the office's approved records procedure.
8. Admin compares the report and reconciliation with the signed log and actual goods records. Resolve discrepancies through the existing independent review process. Record the closing-sheet reference in the closure note, then close only when operations and required reviews are complete.

Historical events opened without package data retain their existing evidence-reference workflow. Their quantities remain unknown; the system does not guess or backfill them. New opening attempts require package setup. Existing issued receipts remain immutable. A later voided claim retains its original handover quantity: **voiding does not record a physical return**. Actual returns need their own authoritative office record and review.

## Current technical role matrix

These are API permissions as implemented, not an appointment of government authority. The process owner must map each action to a named authorized position. The account called `DSWD_STAFF` does not by itself establish that its holder is a DSWD officer or an authorized social worker.

| Action | Admin | DSWD account | Assigned Barangay account |
| --- | --- | --- | --- |
| Register / update beneficiary | Yes | Read | Yes, local; cannot change barangay or lifecycle status |
| Upload / replace documents | Yes | No | Yes, local |
| Review documents | Yes | Yes | No |
| Submit enrollment | Yes | Yes | Yes, local |
| Review enrollment | Yes, independent of submitter | Yes, independent of submitter | No |
| Configure programs and eligibility criteria | Yes | Yes | No |
| Set event/package, allocate, open/close event | Yes | No | No |
| Manage draft schedules | Yes | No | Yes, local |
| Issue / revoke QR credentials | Yes | No | No |
| Verify QR | Yes | Yes | Yes, local |
| Initial face enrollment | No | No | Yes, local |
| Re-enroll a face profile | Yes | No | Yes, local |
| Verify face / collect claim signature | No | Yes | Yes, local |
| Record physical handover | No | No | Yes, local |
| Record simulated wallet credit | No | Yes | No |
| Issue receipt / file claim dispute | Yes | Yes | Yes, local |
| Review claim dispute | Yes, independent of filer | Yes, independent of filer | No |

Sources: current [distribution policy](../src/modules/distributions/distribution.policy.js), [beneficiary policy](../src/modules/beneficiaries/beneficiary.policy.js), [document policy](../src/modules/documents/beneficiaryDocument.policy.js), [enrollment policy](../src/modules/enrollments/enrollment.policy.js), [program policy](../src/modules/programs/program.policy.js), and [biometric policy](../src/modules/biometrics/biometric.policy.js). Enrollment and dispute controllers enforce their additional independence/version checks. Independent enrollment review does not imply that every document action has a separate reviewer rule.

## Exceptions for office review

| Situation | Current supported action | Decision the office must supply |
| --- | --- | --- |
| Missing / rejected document | Correct the existing beneficiary documents and resubmit; independent enrollment review follows. | Exact checklist, accepted alternatives, validity and correction/appeal procedure. |
| Face mismatch / unavailable service / invalid consent | Keep required checks pending. Use the existing retry, consent or independent duplicate-review route. Escalate using the exact record reference. | Who can authorize an accessible alternative and what evidence it requires. There is no manual identity/release override. |
| Beneficiary cannot operate the signature control | The existing typed acknowledgment can be used by the beneficiary where appropriate to the approved service. | Accepted acknowledgment, witness or assisted-signing rules. Typed text is not proof of a representative's authority. |
| Representative or guardian arrives | Refer to the process owner; do not use another person's face or attest that the named beneficiary personally received goods. | Whether representation is allowed, authority documents, actual recipient identity, approval and receipt wording. This flow is not implemented. |
| Package shortage / substitution / partial handover | Do not mark a full claim complete. Preserve the actual signed evidence and refer the exact event/claim to the accountable officer. | Approved recovery, partial-release or substitution rules. Do not enter the planned quantity when it was not received. |
| Missed visit / no appointment | Preserve the original schedule; Admin reviews eligibility and prior assistance before arranging an allowed later event. | Rebooking/cutoff and priority rules. There is no walk-in bypass. |
| Outage before saving | Preserve office evidence and escalate through its approved continuity procedure. | Manual custody, duplicate prevention, later reconciliation and who approves it. The application does not backdate a release or import offline handovers. |
| Connection lost after saving | Retained request retries recover the original result. After leaving the screen, inspect the exact claim first. | Staff responsibility for uncertain-result checks and manual communication. |
| Denied receipt / duplicate concern | File a dispute; an independent assigned reviewer checks current evidence. | Referral office, complaint channel, response times and remedy authority. |

No program-specific exception is marked approved here. An unresolved or inaccessible verification route must be raised with the service owner before using the system for that service.

## Notifications and financial scope

For now, use an office-selected existing communication process for real appointments. Document the channel, responsible staff, confirmation evidence and failed-contact follow-up in the review record. The application's simulated SMS status and tab-local push drafts do not establish delivery to a beneficiary. Simulated wallet credits are not money transfers. A real messaging/payment service requires separate integration and acceptance.

## Source and approval procedure

The official [DSWD Citizen's Charter portal](https://cartportal.dswd.gov.ph/publications/eodb-publication/citizens-charter) lists a 2026 first edition of the unified charter (listing checked 4 November 2026). A listing is not a completed service mapping. Obtain the current edition and exact service pages from the selected office; a DSWD service and a Cebu City local service must not be treated as interchangeable.

For each service step, record its document/version/page, required input, responsible official, expected output, processing time/fee where stated, and the corresponding system screen. Resolve differences in the [office review record](government-procedure-review.md), attach the approved reference through the office's records process, implement agreed changes, and repeat the affected acceptance cases.

**Batch 4's software work can be tested locally. Its government-procedure acceptance gate remains open until the selected process owner approves the mapping and exceptions.** This sign-off does not replace Batch 5 privacy/deployment/recovery acceptance or Batch 6 supervised staff/device testing.

## Developer setup

This change requires migration `20261104010000_physical_package_accountability` and a regenerated Prisma client. From the backend, with the intended development database configured, run `npm.cmd run prisma:migrate:deploy` and `npm.cmd run prisma:generate`, then restart the API. The additive migration leaves historical package fields null and does not modify issued receipt snapshots. It was applied to this workstation's local `garantiyaid_db` on 5 November 2026; deployment to another environment is separate.

Run [integrated acceptance](integrated-acceptance.md) to exercise the new fields and constraints with synthetic data. Do not manually fill historical quantities from assumptions or remove saved handover evidence to resolve a discrepancy.
