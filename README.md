# GarantiyAid backend

Staff API for Barangay, DSWD and Admin workflows. Local acceptance used Node 24.14.0 and PostgreSQL 18. Redis is needed for notification work. Use synthetic records until the office accepts the pilot scope.

## Local setup

1. Run `npm ci`, copy `.env.example` to a private `.env`, and configure the local database and unique JWT/field-encryption keys. Never overwrite an existing field key for a database with encrypted records.
2. Run `npm run prisma:generate` and `npm run prisma:migrate:deploy` against the intended development database.
3. For a new database only, supply protected `INITIAL_ADMIN_*` values and run `npm run prisma:seed`. Remove bootstrap secrets afterward; complete password/TOTP setup.
4. Run `npm run dev`. Start `npm run worker:notifications` separately when Redis and its configuration are ready.

`/api/v1/health` is liveness; `/api/v1/health/ready` checks PostgreSQL and writable evidence storage. Uploads default to `./uploads`; `UPLOAD_ROOT` selects an absolute private volume root and is required in production. Never serve uploads statically. Existing document keys remain portable when moving the complete document tree.

## Operations and verification

- [Railway backend and hosted frontend deployment](docs/pilot-deployment.md)
- [Encrypted backup, restore and outage procedure](docs/pilot-recovery.md)
- [Pilot privacy/operations approval record](docs/pilot-review.md)
- [Supervised pilot session guide and records](docs/supervised-pilot.md)
- [Government procedure and role matrix](docs/government-procedure.md)
- [Staff workflow](../garantiyaid-frontend/docs/staff-workflow.md)
- [SimGate phone pairing, backend configuration and one-recipient SMS test](docs/simgate-setup.md)

Run `npm test`, `npm run security:static` and `npm run prisma:validate`. `npm run verify:integrated` tests the real API/database/browser with disposable synthetic data. `npm run verify:pilot` adds outage and encrypted recovery checks. `npm run pilot:preflight` reports deployment configuration failures without printing secrets; development settings are expected to fail production gates.

SMS defaults to simulation; an explicitly configured SimGate gateway can send real texts through a dedicated Android/SIM. Wallet settlement remains simulated. Local checks do not establish official approval, real SMS delivery, camera/scanner accuracy or production readiness.
