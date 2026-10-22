# GarantiyAid staff web module completion matrix

Reviewed 24 September 2026 and updated 25 September after the physical-release HTTP check, against the workspace `reference/LIST-OF-MODULES.pdf`, the capstone manuscript, current staff routes/pages, Prisma schema, and local automated checks. This replaces the status assessment in the workspace `output/garantiyaid-web-module-audit.md` dated 16–17 September. The source PDF has 68 feature rows in nine groups. Four rows belong solely to beneficiary self-service and remain outside the current web scope. “Implemented” means the staff code path exists and relevant automated checks pass; it is not a claim that the deployed service passed UAT.

The agreed staff duties are narrower than some role ticks in the original PDF: DSWD manages programs and approves enrollment, administrators manage events, facilitators submit enrollment and manage schedules in their assigned barangay. The manuscript module table should be reconciled to this permission matrix before defense; silently broadening access to match every older tick would weaken separation of duties.

| Module | Current staff-web assessment | Consultation caveat |
| --- | --- | --- |
| Account and access | Implemented | Reset email delivery needs a running queue and mail configuration. |
| Beneficiary enrollment | Implemented under agreed roles | Browser walkthrough of registration through approval still needed. |
| Biometric identity | Implemented with remote-service dependency | Real captures, spoof attempts, and outage UAT remain. |
| Programs and subsidy | Implemented under agreed roles | Explain why program management belongs to DSWD. |
| Distribution scheduling | Implemented as deterministic automation | Do not claim an AI optimization model. |
| QR verification and release | Implemented | Physical release through receipt needs live environment walkthrough. |
| Simulated wallet | Implemented | No real money or external payment integration. |
| Dashboard and transparency | Implemented | Two-browser reconnection UAT remains. |
| Notifications and help | Implemented as prototype workflows | Redis worker live test pending; SMS is simulated, mobile push deferred. |

Status key: **Implemented** = connected staff web and backend function; **Service-dependent** = code exists but requires remote processor, Redis, mail, or live multi-browser verification; **Deferred** = beneficiary mobile/self-service scope; **Reference revision** = older PDF role/“AI” language conflicts with the agreed implementation.

## 1. Account and access

| # | Feature in module list | Status | Current behavior |
| --- | --- | --- | --- |
| 1 | Register Account | Deferred | Beneficiary self-registration belongs to the mobile experience. Administrator staff-account creation is covered by row 9. |
| 2 | Login Account | Implemented | Staff password, initial change, TOTP, and session handling. |
| 3 | Logout | Implemented | Server session revocation and client cleanup. |
| 4 | Email / OTP Verification | Deferred | Beneficiary account verification; staff TOTP and reset email are separate controls. |
| 5 | Manage Profile | Implemented | Staff can update allowed contact/profile fields. |
| 6 | Change Password | Implemented | Current-password and account-security checks. |
| 7 | Forgot / Reset Password | Service-dependent | Expiring, hashed, single-use token, uniform request response, session revocation; delivery requires mail worker. |
| 8 | Role-Based Access Control | Implemented | Server roles and barangay scope tested; current permissions below supersede older role ticks. |
| 9 | Manage User Accounts | Implemented | Administrator creates, edits, archives/restores staff. |
| 10 | Activate / Deactivate Account | Implemented | Administrator controls active state. |
| 11 | Two-Factor Authentication | Implemented | TOTP setup, recovery codes, replacement and controlled reset. |

## 2. Beneficiary enrollment and management

| # | Feature | Status | Current behavior |
| --- | --- | --- | --- |
| 1 | Register Beneficiary | Implemented | Administrator or assigned facilitator records a beneficiary. |
| 2 | Upload Documents | Implemented; reference revision | Assigned facilitator uploads/replaces; DSWD reviews. Original PDF also names administrator uploader. |
| 3 | Assign to Program | Implemented; reference revision | Facilitator submits enrollment; DSWD reviews. Original PDF names all staff roles. |
| 4 | View Beneficiary List | Implemented | Role and barangay-scoped list. |
| 5 | Search / Filter Records | Implemented | Search, filters, pagination. |
| 6 | Edit Beneficiary Records | Implemented | Allowed staff edits with server checks. |
| 7 | Verify Eligibility | Implemented | Stored criteria and accepted documents evaluated; mandatory/manual gates visible to reviewer. |
| 8 | Approve / Reject Enrollment | Implemented; reference revision | DSWD review stores an eligibility snapshot and audit evidence. Original PDF also names administrator. |

## 3. Biometric identity

| # | Feature | Status | Current behavior |
| --- | --- | --- | --- |
| 1 | Register Face | Service-dependent | Consent-gated enrollment by administrator/assigned facilitator. |
| 2 | Capture Face | Implemented | Camera/image capture in staff web. |
| 3 | Liveness Detection | Service-dependent | Remote DeepFace anti-spoofing request; simulated processor is only a deterministic development check. |
| 4 | Verify Identity | Service-dependent; reference revision | Administrator/assigned facilitator verify; DSWD performs independent duplicate review, not claim capture. |
| 5 | Match Against Database | Service-dependent | One-to-one claim match and cross-record duplicate scan under active consent. |
| 6 | Detect Duplicate Face | Service-dependent | Candidate matches flag an independent review case; simultaneous enrollments serialized. Real capture UAT pending. |
| 7 | Flag Unrecognized Face | Implemented | Mismatch, liveness, missing profile and processor errors recorded. |
| 8 | Re-enroll Face | Service-dependent | Excludes the same beneficiary from duplicate scan; respects revoked/expired consent. |

## 4. Programs and subsidy

| # | Feature | Status | Current behavior |
| --- | --- | --- | --- |
| 1 | Create Program | Implemented; reference revision | DSWD manages programs; administrator has read access. |
| 2 | Set Eligibility Criteria | Implemented; reference revision | DSWD owns criteria; approval evaluates them. |
| 3 | Set Budget / Amount | Implemented; reference revision | DSWD edits controlled budget and grant values. |
| 4 | Assign Beneficiaries | Implemented; reference revision | Facilitator submits beneficiary enrollment; DSWD approves. |
| 5 | Edit Program | Implemented; reference revision | DSWD lifecycle and update controls. |
| 6 | View Programs | Implemented | Full browser available to all staff, scoped where appropriate. |
| 7 | Activate / Close Program | Implemented; reference revision | DSWD controls program status. |

## 5. Distribution scheduling

| # | Feature | Status | Current behavior |
| --- | --- | --- | --- |
| 1 | Generate Time Slots | Implemented | Administrator and assigned facilitator schedule controls. |
| 2 | Auto-Assign Schedule | Implemented; reference revision | Deterministic, capacity- and service-area-aware allocation; no trained optimizer. |
| 3 | Adjust / Reschedule Slots | Implemented | Schedule mutation is separated from event management and barangay-scoped. |
| 4 | View Assigned Schedule | Implemented | Staff queue and schedule views; beneficiary mobile view deferred. |
| 5 | Send Schedule Notification | Service-dependent | Staff confirms approved templates; Redis/worker required to process, SMS simulated. |
| 6 | Manage Capacity per Slot | Implemented | Slot capacity enforced server-side, assigned facilitator limited to own barangay. |

## 6. QR verification and release

| # | Feature | Status | Current behavior |
| --- | --- | --- | --- |
| 1 | Generate QR Token | Implemented | Administrator issues, revokes, or reissues for an open event. |
| 2 | Scan QR Code | Implemented | Facilitator camera or manual scanner fallback. |
| 3 | Validate Claim | Implemented; reference revision | Administrator/assigned facilitator APIs; field verification UI is facilitator-oriented. |
| 4 | Log Transaction | Implemented | Scan/claim/check-in audit; wallet transactions only for simulated settlement. |
| 5 | Block Duplicate Claim | Implemented | Token state, unique constraints and idempotency. |
| 6 | Mark Claim Released | Implemented | Local HTTP verifier confirms facilitator release once with actor, time, evidence, receipt and reconciliation; deployed UAT remains. |

## 7. Simulated wallet

| # | Feature | Status | Current behavior |
| --- | --- | --- | --- |
| 1 | Create Wallet | Implemented | Authorized creation and beneficiary-ID lookup. |
| 2 | Simulated Wallet Credit After Verification | Implemented | One-time claim settlement, no real funds. |
| 3 | Simulated Transfer | Implemented | Confirmation and idempotent closed-loop transfer. |
| 4 | View Wallet Balance | Implemented | Individual wallet detail and balance. |
| 5 | Record Transaction | Implemented | Debit/credit history and immutable references. |
| 6 | View Transaction History | Implemented | Paginated individual ledger and matching transfer sides. |
| 7 | Generate Receipt | Implemented | Claim and transaction receipts. |
| 8 | Reconcile Distribution | Implemented | Separates physical goods from simulated wallet credit. |

## 8. Realtime dashboard and transparency

| # | Feature | Status | Current behavior |
| --- | --- | --- | --- |
| 1 | View Distribution Statistics | Implemented | Role-scoped overview and reports. |
| 2 | Monitor Live Claims | Service-dependent | Overview and facilitator queue subscribe to sanitized Socket.IO events; two-browser UAT pending. |
| 3 | View Claim Status | Implemented | Claim and settlement views. |
| 4 | Generate Reports | Implemented | Role-scoped operational reports. |
| 5 | Export Data | Implemented | Controlled CSV export. |
| 6 | View Audit Logs | Implemented | Paginated, immutable audit history; no delete-all action. |
| 7 | Track Fund Utilization | Implemented | Explicitly simulated values and reconciliation. |

## 9. Notifications and help

| # | Feature | Status | Current behavior |
| --- | --- | --- | --- |
| 1 | Send SMS Notification | Service-dependent | Controlled schedule templates and queue/retry; current provider simulates delivery only. |
| 2 | Send Push Notification | Deferred | Beneficiary mobile push is outside staff web scope. |
| 3 | View Notification History | Implemented | Queued, sent, failed and retry states. |
| 4 | Ask Chatbot | Deferred | Public help interface exists; beneficiary account/mobile integration deferred. |
| 5 | Receive Automated Answer | Deferred | Public controlled knowledge answer exists; beneficiary account/mobile integration deferred. |
| 6 | View Chat History | Implemented | Administrator can inspect generic cases; linked cases are role/barangay-scoped. |
| 7 | Escalate to Staff | Implemented | Inbox, referral, assignment, reply, and resolution with redacted transcript. |

The four deferred rows are 1.1, 1.4, 9.4 and 9.5. Row 9.2 is a fifth deferred *staff-list feature* because its beneficiary mobile delivery target is out of this web release. Therefore the 64 staff-related PDF rows are not equivalent to 64 deployed-and-UAT-passed features.
