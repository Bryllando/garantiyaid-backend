# Railway backend and hosted frontend pilot preparation

Prepared 5 November 2026. This is an operating guide for the implemented software, not a deployment or office approval. Use synthetic records until the [office procedure review](government-procedure-review.md) and [pilot privacy/operations review](pilot-review.md) are accepted. The selected Cebu City office/program remains unresolved.

## Service layout

Use one API instance, a separate notification worker, PostgreSQL, Redis and the approved remote biometric processor. The frontend is a static HTTPS site. The API owns a private persistent volume for supporting documents. Face templates, signatures, receipts and authentication records are in PostgreSQL; their application encryption key must survive recovery.

| Service | Build / start | Storage and network |
| --- | --- | --- |
| API | Install with `npm ci`; build `npm run prisma:generate`; start `npm start` | HTTPS public domain; Railway-provided `PORT`; private database/Redis; volume mounted at `/data`, `UPLOAD_ROOT=/data/uploads` |
| Notification worker | Same backend install/generation; start `npm run worker:notifications` | No public domain; same database, Redis and queue name; no document volume needed |
| Controlled migration job | Same backend release and dependencies; `node scripts/deploy-migrations.js` | Separate migration credentials; no public domain or persistent volume required |
| Hosted frontend | `npm ci`, then `npm run build`; publish `dist` | `VITE_API_URL=https://<api-domain>/api/v1`; HTTPS; SPA fallback to `index.html` for application routes |

Use the two existing repositories as separate service sources. If combined into a parent repository later, select the corresponding service root directory. Keep reviewed lockfiles and record the release identifiers for both repositories. Local acceptance used Node 24.14.0 and PostgreSQL 18; configure a supported Node 24 release and matching PostgreSQL client tools in the operator environment.

Railway documents persistent-volume behavior and separate pre-deploy containers. Volumes are unavailable during pre-deploy, so storage probes belong after API startup. A volume redeployment can have downtime; schedule a service window. [Volume guide](https://docs.railway.com/volumes), [pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command).

Configure the settings in the current Railway service UI or its supported infrastructure tooling. The current Railway reference deprecates `railway.json`/`railway.toml` configuration for new work; this change does not introduce a legacy configuration file. [Railway configuration reference](https://docs.railway.com/config-as-code/reference).

## Configuration and credentials

Set these in the backend service's protected variables, never in frontend variables, source, tickets or screenshots:

| Setting | Required pilot value/action |
| --- | --- |
| `NODE_ENV` | `production` |
| `ENFORCE_HTTPS` | `true` |
| `TRUST_PROXY_HOPS` | Match the actual Railway/proxy chain. Verify HTTPS detection and client IPs in staging; never guess a larger trust boundary. |
| `CORS_ORIGIN` | Exact hosted frontend HTTPS origin(s), without paths or a wildcard |
| `PUBLIC_APP_URL` | Exact hosted frontend HTTPS URL used in security email links |
| `DATABASE_URL` | Dedicated runtime role, not the database owner/admin; verified TLS for a remote connection |
| `UPLOAD_ROOT` | `/data/uploads` on the API's mounted private volume; production requires an explicit absolute path |
| `JWT_ACCESS_SECRET` | Unique random secret of at least 64 characters; protect and rotate through the operations process |
| `JWT_ACCESS_EXPIRES_IN` | `15m`; production accepts only 5–60 minutes |
| `FIELD_ENCRYPTION_KEY` | Exactly 64 random hexadecimal characters. Retain the original key for existing encrypted records; replacing it makes them unreadable. |
| `REDIS_URL` | Protected Redis connection; verified encrypted transport where available/required by the approved design |
| `BIOMETRIC_PROCESSOR_MODE` | `REMOTE` in production; authenticated HTTPS endpoint/key and accepted calibration are required |
| `EMAIL_PROVIDER_MODE` | Approved configured provider, or `DISABLED` with an agreed account-recovery procedure; test delivery before staff onboarding |
| `SMS_PROVIDER_MODE` | `SIMULATED`; no real SMS delivery is implemented |

The worker needs production-valid configuration but does not read document files; provide its absolute storage setting without mounting or copying beneficiary documents there. Keep `MIGRATION_DATABASE_URL` only in the controlled migration job/operator context. That job also receives the runtime URL to verify it is targeting the same endpoint/database with a different role. Do not retain migration or backup keys on the public API service. Railway pre-deploy commands inherit their service's variables, so do not use them as a substitute for separating credential access.

Configure PostgreSQL roles with the responsible operator: the migration owner performs DDL; the runtime role gets connection/schema usage, required table SELECT/INSERT/UPDATE/DELETE and sequence usage, including default privileges for future migrations. The runtime role must not own the schema/tables or have superuser, role-creation, database-creation or replication privileges. Grant read access to `_prisma_migrations` for preflight, without write privileges. Do not execute migration SQL with the runtime role or use `prisma db push` on pilot data.

The current limiter and upload storage assume **one API instance**. Multiple instances need a shared rate-limit store and shared protected document storage first. Do not expose `/data/uploads` through the frontend, a static-file route or a public bucket.

## Deployment sequence

1. Complete the approval/owner fields in [pilot review](pilot-review.md). Establish secrets custody, private storage permissions, malware-handling controls and backup destination before any real-person records.
2. Provision separate staging and pilot databases/volumes. Use synthetic records in staging. Configure services and frontend build variables, with worker outbound delivery disabled during rehearsal.
3. Take and verify a coordinated backup before updating an existing environment. Stop the API's writers and the separate worker as described in [recovery](pilot-recovery.md).
4. Run the controlled migration job for this exact release. Its wrapper refuses mismatched databases or using the runtime role for migrations. A failed migration stops release; inspect history and the failure without printing credentials. Never reset the pilot database.
5. Deploy the API with its persistent volume and generated Prisma client. Use `/api/v1/health/ready` as its Railway healthcheck. It returns 503 if PostgreSQL or document storage is unavailable. `/api/v1/health` checks only process liveness. GET/HEAD health probes are data-free and can run over the platform's internal HTTP path; protected staff endpoints still enforce HTTPS.
6. Run `npm run pilot:preflight` in the deployed API/operator environment. Exit 1 means a technical gate failed. Inspect its redacted results, fix the configuration, and repeat. Passing this check does not verify provider encryption, volume durability, office approval, remote biometric accuracy or backups.
7. Publish the frontend with its actual API domain. Production builds reject missing, HTTP, localhost or credential-bearing API URLs. Enable SPA fallback and test a direct link to a beneficiary/claim after sign-in. The API URL is public configuration, not a secret.
8. Create the first named administrator through the controlled seed process, then remove `INITIAL_ADMIN_*` secrets. Complete mandatory password change/TOTP. Provision named staff accounts and assigned barangays; prohibit shared accounts. Test deactivation and session revocation using synthetic staff.
9. Restart the notification worker only after its delivery configuration is verified. Test the approved real security email flow separately. SMS and wallet entries remain simulated.
10. With separate roles, rehearse the [staff workflow](../../garantiyaid-frontend/docs/staff-workflow.md), signed-log reconciliation, storage survival after redeployment and the actual staff devices. Record failed steps and evidence in [pilot review](pilot-review.md).

Railway's deployment healthcheck does not provide continuous monitoring. Configure an external HTTPS readiness monitor, storage/database capacity alerts, failed-backup alerts and notification-worker failure alerts; assign the recipient and response time. Avoid logging health payloads, request bodies, query strings or downloaded evidence. [Railway healthchecks](https://docs.railway.com/deployments/healthchecks).

## Rollback and incidents

Use the prior reviewed application artifact only when it is compatible with the current database schema. Do not delete migrations, run `migrate reset`, or automatically restore an older database over later handovers. For an incompatible migration or evidence discrepancy, enter maintenance, preserve current evidence, restore into a separate environment and reconcile the gap before an authorized switch.

On suspected unauthorized access, stop affected operations, revoke the affected account/sessions, preserve restricted audit evidence and notify the named incident/privacy leads. They determine containment, notification duties and timing against the applicable incident procedure. Do not copy documents, biometric data or secrets into a bug report. Record request IDs and case references through the approved channel.
