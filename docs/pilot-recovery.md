# Coordinated backup, restore and outage rehearsal

This procedure supports the current single-API/private-volume design. It was exercised locally with synthetic records on 5 November 2026. A deployed schedule, separate backup location, key custodians and office-approved recovery objectives remain operational decisions.

## What a backup contains

`npm run pilot:backup` creates an authenticated AES-256-GCM encrypted directory containing a PostgreSQL custom-format dump, every document referenced in `beneficiary_documents`, the original `FIELD_ENCRYPTION_KEY`, and an encrypted checksum/table-count manifest. It checks document hashes against saved evidence. A missing or changed document fails the backup. The authenticated manifest is published last; a folder without `manifest.enc` is incomplete.

Use a separate random 64-hex-character `BACKUP_ENCRYPTION_KEY` from an approved secret manager. The tool refuses using the field-encryption key as the backup key. Keep backup keys separately from the encrypted bundles, with access/recovery ownership and a tested escrow process. Losing both the original field key and its decryptable backup makes TOTP, biometric templates, signatures and encrypted import data unrecoverable.

The bundle does not contain application source/artifacts, database connection passwords, JWT signing keys, email/provider keys, Redis queues or unreferenced orphan files. Preserve exact release identifiers, lockfiles and the protected deployment configuration inventory separately. The database retains notification records, but Redis jobs are not restored: reconcile pending/uncertain messages before requeueing, and never assume delivery from a database status alone.

The tool uses private temporary files while creating/restoring the dump and field-key file, then removes its own staging directory. Use an encrypted operator disk/temp directory with restricted OS permissions; Unix file modes alone do not establish Windows ACL protection. Never place bundles or recovery directories in a webroot, shared folder or source repository. Ordinary deletion is not a guarantee of secure erasure on all storage.

## Stop writers and create a backup

1. Arrange the service window and stop staff handovers. Resolve uncertain saved responses first by inspecting the exact claim and preserving its original request/log evidence.
2. Stop the separate notification worker and any scheduler, import client or external database writer. Put the API into maintenance. On Railway, temporarily set start command to `node scripts/pilot-maintenance.js` and healthcheck to `/maintenance-health`, then deploy that maintenance process against the same volume. It starts no application/database workers, returns 503 for staff reads/writes and allows only its separate probe. Confirm old API instances and the worker have stopped; do not run the ordinary API alongside it.
3. Use an approved operator environment with Node, the backend dependencies and PostgreSQL 18 `pg_dump`/`pg_restore`. Set `PG_BIN` to the client executable directory when different from the Windows default. Ensure it can reach the database securely and read the mounted documents. For a workstation backup, copy the complete document tree from Railway's volume to its encrypted working directory while all writers remain stopped, then point `UPLOAD_ROOT` at that copy. The tool checks every referenced file; a partial export fails. Use Railway's supported private volume access/export, never a temporary public download route. [Railway volume access](https://docs.railway.com/volumes).
4. Supply `DATABASE_URL`, the original `FIELD_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY` and `UPLOAD_ROOT` securely. Do not type secret values into shared shell history. Create the approved parent backup directory first; the new backup directory itself must not exist.
5. Run from the backend, for example on the authorized Windows operator workstation:

   ```powershell
   npm.cmd run pilot:backup -- create D:\ProtectedBackups\pilot-2026-11-05 --writers-stopped
   ```

   `--writers-stopped` is an operator attestation, not a lock that stops other processes. The count/hash checks catch some changes but do not replace quiescing every writer. Keep writers stopped until the command exits successfully and the bundle has been copied to the separately controlled backup location.
6. Verify a restore of that bundle using the steps below. Restore normal API command/healthcheck, check readiness and the exact saved claims, then restart approved workers. Record the backup identifier, UTC timestamp, operator, destination, verification and any gap.

Schedule coordinated backups at an owner-approved interval and before releases. Automatic Railway volume backups can supplement this procedure, but independently timed database and document snapshots are not evidence of one consistent recovery point. Monitor successful completion and off-service copying; an untested or failed bundle does not meet the recovery gate. [Railway volume backups](https://docs.railway.com/volumes/backups).

## Restore into a separate environment

1. Keep the affected system isolated/under maintenance. Preserve its latest database, files, logs and signed release log for comparison; do not overwrite the only copy of post-backup handovers.
2. Provision an empty PostgreSQL recovery database and an unused private recovery directory. Grant its controlled restoration role the needed schema permissions. The command refuses a database with existing objects and does not issue DROP/CLEAN against it.
3. Set `RESTORE_DATABASE_URL` explicitly to that recovery database and retrieve the separate `BACKUP_ENCRYPTION_KEY`. The restore does not use `DATABASE_URL` as a fallback.
4. Run:

   ```powershell
   npm.cmd run pilot:backup -- restore D:\ProtectedBackups\pilot-2026-11-05 D:\ProtectedRecovery\pilot-2026-11-05
   ```

5. Accept only exit 0 plus `restore-result.json`. All members must authenticate and match their checksums before database restoration. `pg_restore` uses a single transaction with exit-on-error. Only restore trusted bundles; a database archive can contain executable SQL. [PostgreSQL restore documentation](https://www.postgresql.org/docs/18/app-pgrestore.html).
6. Verify table counts, saved receipt hashes, physical quantities and document checksums. The script checks counts and bundle hashes; the repeatable rehearsal also decrypts TOTP/face/signature evidence and compares receipts/documents. Review actual recovery evidence against the signed log, including releases after the backup timestamp.
7. Transfer `field-key.json` into the approved secret store; configure its original key and set `UPLOAD_ROOT` to the recovered `uploads` directory. This key file is plaintext in the restricted recovery directory. Protect it, then dispose of the temporary recovery copy under the approved policy after secret custody is verified.
8. Rotate JWT signing credentials before reopening. Restore automatically revokes all staff sessions, password-reset links and recovery codes so an older backup cannot reactivate them. Reapply account deactivations, permission changes and credential changes made after the backup before allowing sign-in; the restored account/password state is historical. Staff must sign in again; reissue recovery codes through verified account access. Restore provider credentials/configuration from the secret manager, with outbound workers disabled initially.
9. Run readiness/preflight and the cross-role journey with synthetic data in the recovery environment, verify representative document downloads and reports, then obtain the incident/process owner's approval for switching traffic. Record recovery time and unreconciled gaps. The script does not switch domains or deploy a restored service.

If restoration fails after database restoration but before all files/results are published, the new target is **not accepted**. Keep it isolated, inspect the failure, and retry into another empty target. Do not start an API against partial recovery or reuse an occupied target. The tool preserves the original encrypted bundle.

## Repeatable local rehearsal

```powershell
npm.cmd run verify:pilot
```

This extends [integrated acceptance](integrated-acceptance.md) with a temporary loopback PostgreSQL outage/restart, missing-storage checks, encrypted backup and restore into another fresh database. It uses synthetic staff/documents, simulates face processing/wallet/SMS, disables external delivery, and deletes only its own test instances. It does not stop the development database or use its credentials.

Read `../output/pilot-acceptance/results.json`: require `passed`, `databaseRemoved` and `recoveryDatabaseRemoved` to be true and exit 0. The recorded elapsed time covers the small synthetic backup/recovery exercise, including negative tests; it is not a production recovery-time promise. Have the office approve maximum tolerable data loss (RPO) and service recovery time (RTO), then measure a representative deployed rehearsal.

## Staff outage rules

- Before a handover is recorded: pause the release workflow and use the office-approved continuity process. The app does not import offline releases or backdate them.
- After an uncertain response: retry the retained request or inspect the exact claim before any further handover. Do not change quantities/evidence or create a second release to recover a lost response.
- After an outage or restore: compare system records with original signed logs before reopening. Any release after the backup can be missing from the restored system; a technical restore alone cannot resolve that discrepancy.
- For real power failure, scanner/camera/printer problems and inaccessible verification: follow the process owner's approved exception procedure. Record device/staff acceptance in [pilot review](pilot-review.md).
