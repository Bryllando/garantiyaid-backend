# Pilot privacy and operations review record

Status: **DRAFT — NOT APPROVED**. Prepared 5 November 2026 for the proposed Cebu City scope and Railway backend/hosted frontend. Technical preparation is implemented locally; the selected office must complete this record before using real-person pilot data.

NPC's guidance for Circular 2023-06 covers privacy assessment, controlled access and continuity including backup/restoration. Its announcement states that this circular repealed Circular 16-01. The office's privacy lead must assess current applicable requirements and document its decisions; this form is not a completed PIA or certification. [NPC announcement and circular links](https://privacy.gov.ph/npc-issues-circulars-to-strengthen-personal-data-protection-in-ph/).

## Named responsibility and scope

| Decision / owner | Office-approved value and evidence |
| --- | --- |
| Sponsoring office, named service and authorized barangays | Pending; proposed locality Cebu City |
| Process owner and authority for staff roles | Pending; use the [government procedure review](government-procedure-review.md) |
| Personal-information controller / privacy lead / DPO | Pending |
| Deployment, database and backup operator; alternate | Pending |
| Incident lead, support channel and escalation contacts | Pending |
| Records custodian for signed logs, exports and printed receipts | Pending |
| Approved pilot participants, duration and devices | Pending |
| Maximum tolerable data loss (RPO) / service recovery time (RTO) | Pending; local synthetic timings are not approved objectives |
| Backup frequency, separate destination, retention and restore-drill interval | Pending |
| Backup-key and field-key custody, escrow and rotation | Pending |
| Actual notification channel and failed-contact follow-up | Pending; SMS and wallet settlement remain simulated |

## Data inventory for the PIA

| Data / purpose | Current storage and access | Office decision required |
| --- | --- | --- |
| Staff identity, roles, authentication and recovery | PostgreSQL; password hashes, encrypted TOTP, revocable sessions | Provisioning, least privilege, access review, recovery identity check and offboarding |
| Beneficiary identity, contact/address and assessment | PostgreSQL; role/Barangay controls; personal fields need infrastructure protection | Necessity, lawful processing basis, notice, accuracy/correction and complaints |
| Supporting documents and filenames | Private API volume; database metadata; authorized downloads audited; content/size/path checks | Types/alternatives, malware/quarantine, encryption, download/export controls and custody |
| Face captures, templates, consent and attempts | Captures sent to configured remote processor; encrypted templates and consent/attempt records in PostgreSQL | Necessity, provider terms/location/retention, accessible alternative, calibration and mismatch review |
| Signature and acknowledgment evidence | Encrypted images in PostgreSQL; signed physical log with office | Actual recipient/representative rules, witness/accessibility and physical custody |
| Allocations, schedules, QR, quantities, claims, disputes and receipts | PostgreSQL; immutable receipt snapshots; printable/exportable records | Reconciliation, appeal/correction authority, legal holds, disclosure and retention |
| Audit and request metadata | Database audit and restricted operator logs; request IDs; production exception logs omit query values/stacks | Recipients, retention, alerts and incident evidence custody |
| Help and notification records | PostgreSQL and Redis jobs; optional configured external services | Data-flow/provider review, approved wording, delivery evidence and failed-job recovery |
| Backups, recovery files and exports | Encrypted bundles; decrypted recovery/CSV/PDF copies remain sensitive | Separate location, key access, download restrictions, retention and disposal |

Leave optional external guidance credentials unset until its data flow is approved. Local tests disable external delivery. Do not place real records, secrets, raw biometric data or recovery codes in this repository or ordinary support tickets.

Expired/revoked biometric consent blocks use; it does **not** prove deletion of stored templates. Some assistant-history/import cleanup exists, but no office-approved deletion schedule covers all records, uploads, logs and backups. Record class-specific retention/legal holds before implementing disposal. Preserve issued evidence when reviewing a discrepancy.

## Technical and operational gates

| Gate | Local evidence / current state | Deployed or office evidence needed |
| --- | --- | --- |
| Least privilege and independent review | API scopes/version checks and cross-role/area tests | Named authorization; restricted DB runtime role; offboarding and recovery |
| Transport and sessions | Production configuration validation; short-token checks; safe frontend API URL guard | Real TLS/certificate, exact proxy trust and verified downstream links |
| Private durable uploads | Absolute volume root, portable file keys, readiness/path tests | Volume survives redeploy; storage encryption and malware controls |
| Backup/recovery | Encrypted dump/documents/key restore; tamper/overwrite rejection; old authentication recovery revoked | Schedule/alerts, separate storage, key escrow, representative restore and accepted RPO/RTO |
| Outages | Database interruption/recovery, storage failure and same-request release retry | Power/network/device tests and approved manual reconciliation |
| Monitoring/response | Readiness/liveness, request IDs and audit trail | Continuous monitoring, storage/worker/backup alerts, named response contact |
| Procedure/privacy | Guides and data inventory prepared | Signed service mapping, PIA/notice/retention/accessibility/provider decisions |

## Staff and device acceptance

Use the [supervised session guide](supervised-pilot.md) and copy its [session record](pilot-session-template.md) to retain observations, issues, retests and closing sheets. Current Batch 6 scope is local synthetic rehearsal; actual staff acceptance remains pending.

Use synthetic records first. Record date, tester, role/device, expected/actual result, issue reference and approver for each row. Blank results are pending.

| Exercise | Result / evidence |
| --- | --- |
| Named Admin, DSWD and Barangay staff complete the guide; wrong-area access denied | Pending actual staff |
| Deactivation removes an active session; recovery verifies identity | Pending deployed test |
| Real camera, consent, genuine/mismatch/spoof captures and lighting | Pending; local face results are simulated |
| QR scanner reads the correct event; duplicate leads to existing claim | Pending actual scanner |
| Keyboard/mobile, accessible procedure and required signature | Pending actual staff/devices |
| Printer produces readable recipient/package/log references; paper stored securely | Pending actual printer |
| Network lost before save and after successful save preserves original evidence | Local API tests passed; deployed repetition pending |
| Power/redeploy interruption preserves documents and handovers | Local DB restart passed; real power/volume test pending |
| Signed log, quantities, voided handovers and receipts reconcile before closure | Local synthetic checks passed; office acceptance pending |
| Separate-environment restore and post-backup release reconciliation | Local synthetic restore passed; deployed operator drill pending |

## Approval outcome

- Government procedure, authority and exceptions: **Pending**
- PIA, notice, retention and provider decisions: **Pending**
- Deployment, least privilege, storage and malware controls: **Pending**
- Backup custody/schedule, recovery objectives and deployed drill: **Pending**
- Support/incident responsibility and staff/device acceptance: **Pending**
- Approving positions, decision, date and retained approval reference: **Pending**

Complete these gates before Batch 6 supervised pilot. Retain signed originals through the office's records process. Editing this file does not grant approval.
