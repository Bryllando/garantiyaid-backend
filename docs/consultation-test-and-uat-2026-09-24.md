# GarantiyAid consultation test and UAT record

This record distinguishes local checks run on 24–25 September 2026 from acceptance checks that still need people, devices, and deployed services. It is not a deployment certificate. Beneficiary mobile/self-service is outside this staff web review. Use the **Service review** page in the signed-in web portal as the demonstration checklist.

## Automated results

| Check | Result | What it establishes |
| --- | --- | --- |
| Backend `npm.cmd test` | Passed, 280/280 | Route, policy, service, physical-release, biometric, password-reset, chatbot, queue-worker and Socket.IO behavior under automated tests. |
| Frontend `npm.cmd test` | Passed, 102/102 | Staff UI helpers and component behaviors covered by the suite. |
| Frontend lint and production build | Passed | Compiles and lints; Vite reports a pre-existing main bundle size warning. |
| Prisma schema validation | Passed | Local schema parses. This does not prove production migrations have run. |
| Backend static security check | Passed | Repository static checks. |
| `npm.cmd run verify:workflow` | Passed locally | Document upload/review, eligibility, enrollment decision and audit over HTTP, using a temporary assigned facilitator. Starts from an existing beneficiary. |
| `npm.cmd run verify:distribution` | Passed locally | Event, slots, allocation, scheduling, QR claims, simulated wallet, and simulated biometric paths. The biometric component is deliberately simulated. |
| `npm.cmd run verify:distribution:claims` (25 September) | Passed locally | QR verification through one-time physical release, receipt, audit, no wallet transaction, and reconciliation over HTTP. |
| `npm.cmd run verify:notifications` | Blocked by environment | Redis queue unavailable locally; no live queued/sent/failed lifecycle was certified by this run. Automated worker tests passed. |
| `npm.cmd run verify:biometric:remote ...` | Not run | Needs a reachable remote processor plus consented real capture, different-person, and spoof files. |

The local workflow verifier needs active System Administrator and DSWD accounts, an assigned active facilitator, an active barangay and beneficiary, PostgreSQL migrations, and appropriate local environment variables. A temporary facilitator was created for this run and then removed along with interrupted test artifacts. Node 24’s `pg` deprecation warning had previously made scripts using `--throw-deprecation` abort after writing test records; verifier commands now allow the warning while still failing on actual test errors.

## Scenario record and live acceptance steps

Record operator name, date, environment, input IDs, result, and screenshot or audit/receipt reference in a separate consultation log. Do not put QR secrets, face images, password reset links, or full contact numbers in that log.

| # | Scenario | Automated evidence | Live UAT to perform | Current acceptance state |
| --- | --- | --- | --- | --- |
| 1 | Registration → documents → eligibility → approval | HTTP workflow passed; registration and authorization have automated coverage | Register a new test beneficiary in the web UI, upload documents as facilitator, review as DSWD, confirm criteria and final audit snapshot | **Pending browser walkthrough** |
| 2 | Program allocation → scheduling → QR | Distribution verifiers passed | Activate a test program, allocate approved enrollment, generate slots/schedules, open event, issue QR, inspect queue | **Pending deployed walkthrough** |
| 3 | QR/face/signature → physical release → receipt | QR-to-release-to-receipt HTTP verifier passed with QR requirement; unit checks cover combined biometric/signature rules | Verify required factors on a deployed physical event, release once, retry with same and different idempotency keys, inspect receipt, audit, report and reconciliation | **Pending deployed walkthrough and real capture** |
| 4 | Simulated credit → transfer → receipt → reconciliation | Wallet HTTP verifier passed | Inspect both beneficiary wallet histories and matching debit/credit, receipt and event reconciliation in web UI | **Pending deployed walkthrough** |
| 5 | Duplicate face and claim | Duplicate/mismatch, consent and claim checks passed using simulated/automated inputs | Real same-person/different-person captures, replay, spoof attempt, revoked/expired consent, processor outage; verify authorized review case | **Pending remote biometric UAT** |
| 6 | Cross-barangay and denied role | Policy/HTTP tests passed | With real role accounts, attempt direct cross-barangay API mutations and denied actions; confirm 403 and unchanged records | **Pending consultation account UAT** |
| 7 | Password recovery and session revocation | Password reset tests passed | Deliver email, consume link once, retry used/expired link, call protected endpoint from prior session, inspect security notice | **Pending mail-queue UAT** |
| 8 | Chat escalation, reply and resolution | Chatbot service/HTTP tests passed | From public help, trigger escalation; sign in as staff, assign, reply, resolve; inspect generic/linked access boundaries | **Pending two-browser UAT** |
| 9 | Live dashboard and queue | Socket.IO authentication, room and event tests passed | Two browsers: modify schedule/release claim, observe affected view; disconnect/reconnect, preserve filters/selection, sign out | **Pending two-browser UAT** |
| 10 | Notice success, failure, retry | Queue/worker unit tests passed | Start Redis and worker, enqueue schedule notices, simulate one failure, retry, inspect one stable history row and final states | **Blocked until Redis and worker run** |

## Acceptance environment

Use a disposable consultation dataset, not real beneficiary biometrics or identity documents. Apply Prisma migrations before starting the API. Start the API, frontend, PostgreSQL, Redis, notification worker, and mail worker/configuration for the applicable scenarios. Set `BIOMETRIC_PROCESSOR_MODE=REMOTE` and a reachable DeepFace/ArcFace processor for real capture UAT; the simulated mode is not proof of liveness performance. The notification provider is currently `SIMULATED`, so a `SENT` state means the simulated worker completed; it does not mean a phone received an SMS. Use two authorized staff accounts and separate browsers for live updates. Keep a facilitator assigned to the test barangay and another barangay for denial tests.

The consultation is complete only when each pending live check is executed and its observed result is recorded. A failed check should retain the error, exact step, environment, and corrective follow-up; do not convert it to “pass” because a unit test passed.
