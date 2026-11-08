# Integrated capstone acceptance

Run from `garantiyaid-backend`:

```powershell
npm.cmd run verify:integrated
```

Both application repositories must be adjacent, with their existing dependencies installed. The runner uses the frontend's installed Playwright and Vite, local Chrome, and PostgreSQL command-line binaries. On this Windows workstation PostgreSQL is at `C:/Program Files/PostgreSQL/18/bin`. If yours differs, set `PG_BIN` to the directory containing `initdb`, `pg_ctl` and `postgres` before running. Windows may require running outside Codex's restricted sandbox because PostgreSQL creates its own restricted process token.

The command starts a fresh, password-protected PostgreSQL instance on a free loopback port. It does not read or use the application's development `DATABASE_URL`. It creates a uniquely named acceptance database, applies every repository migration, creates synthetic staff and two barangays, then starts the real Express API, Socket.IO server and Vite frontend on free loopback ports. Browser requests go to that API. The application modules and database methods are not mocked.

Staff sign in through the actual password/TOTP API. The browser receives those real sessions through the application's session-storage format. This tests authenticated workflows and session revocation; it does not replace a manual test of the sign-in form or account provisioning. Supporting documents, names, identities and signature acknowledgments are synthetic.

## Checks

- Physical package definition is required before opening. Whole-unit quantity validation, draft editing and frozen open-event configuration are exercised. Short/excess handovers cannot complete a claim; package evidence persists through release, receipt, reconciliation and reports.
- Independent remediation of a physical claim retains its original handover count, quantity and issued receipt. Reconciliation and report screens show the retained handover at 1440, 390 and 320 pixels, even when current completed-claim count is zero.
- Document requirements, independent enrollment review, and API access across barangay boundaries.
- Two operators allocating the same enrollment, scheduling the same beneficiary, recording the same physical handover, issuing a receipt, crediting the same wallet claim, and closing an event. Saved allocations, queues, transactions, receipts and audit records must agree.
- Dispute versus physical release and dispute versus simulated credit. A PostgreSQL row lock pauses completion after its initial checks. The suite verifies the request is waiting, commits a competing concern, then releases the lock. The stale completion must fail without saving a release or transaction. Self-review and decisions using stale claim evidence must also fail.
- Required QR, simulated face, and typed signature checks. A partial claim cannot be released or credited. A mismatch, expired consent and revoked consent cannot pass identity verification.
- A browser journey through registration, document rejection/correction/resubmission, independent approval, allocation, scheduling, QR, physical handover, receipt and Admin closure.
- A browser journey through QR plus simulated face, simulated wallet credit, receipt and Admin closure. Keyboard signature submission exercises the real signature endpoint.
- A deliberately lost physical-release response **after the real API saves successfully**. Retrying must send the same key and preserve one original release, evidence and audit record. A real claim-list response is also delayed to check that background refresh does not interrupt receipt issuance. No successful response is fabricated.
- Persisted reports and reconciliation totals agree with completed claims and receipts. All three roles see the same saved receipt and closure at desktop/mobile sizes. A revoked database session removes browser access.

## Results and reset

For Batch 5 preparation, run `npm.cmd run verify:pilot`. It includes this same journey plus database interruption, evidence-storage readiness and encrypted backup/restore checks. Its separate output is `../output/pilot-acceptance`; require both test databases to be removed. See the [recovery guide](pilot-recovery.md) for scope and limits.

Read `../output/integrated-acceptance/results.json` after the command finishes. Success requires `passed: true`, exit code zero, and `databaseRemoved: true`. `setup.log` records database initialization/migrations. Screenshots are in the same output directory; `failure.png` is written if a browser assertion fails.

Every invocation is a startup/reset rehearsal: it creates a new empty database and synthetic dataset. The runner drops only the database it created, stops only its own PostgreSQL instance, and removes its own temporary directory after normal success or failure. It preserves screenshots and the result report. A forced termination or machine crash can interrupt cleanup; inspect the named `tmp/garantiyaid_acceptance_<run-id>` instance before removing it. Never run a generic database reset against the development or production configuration.

The synthetic data is intended for a repeatable automated demonstration, not permanent demo accounts. For a supervised manual demonstration, follow the [staff workflow](../../garantiyaid-frontend/docs/staff-workflow.md) with approved synthetic records in a separate demonstration environment.

Use the [Batch 6 session guide](supervised-pilot.md) to prepare that observation, record issues and retests, reconcile each event and hand over operations. Automated results do not populate or approve the staff/device acceptance fields.

## Limits

This suite tests PostgreSQL transaction behavior and actual HTTP/browser integration for the listed cases. It is not a load benchmark or an exhaustive security audit. The face processor, wallet settlement and SMS remain explicitly simulated; email delivery is disabled and notification workers are not started. It does not test remote face accuracy, a live scanner/camera/printer, SMS delivery, real payments, disaster recovery, or official government approval. Those remain later roadmap gates.

The existing Prisma/Postgres adapter `client.query()` deprecation warning may appear. It is recorded as a dependency compatibility concern, not suppressed by this runner.
