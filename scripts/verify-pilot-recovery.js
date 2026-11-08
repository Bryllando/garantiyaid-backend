import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, rename, cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { createBackup, restoreBackup, fileHash } from './pilot-backup.js';
import { checkReadiness } from '../src/lib/readiness.js';
import { env } from '../src/config/env.js';
import { decryptTotpSecret } from '../src/modules/auth/totp.service.js';
import { decryptBiometricTemplate } from '../src/modules/biometrics/biometric.service.js';
import { decryptSignatureImage } from '../src/modules/biometrics/claimSignature.service.js';

export async function runPilotRecovery({ prisma, baseUrl, workspace, connection, maintenance, databaseName, report, restartDatabase, stopApi }) {
  const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
  const ready = () => fetch(`${baseUrl}/api/v1/health/ready`, { signal: AbortSignal.timeout(10000) });
  assert.equal((await ready()).status, 200);
  const documentsDirectory = join(env.uploadRoot, 'beneficiary-documents');
  assert.equal(env.uploadRoot, join(workspace, 'persistent-uploads'));
  await rename(documentsDirectory, join(env.uploadRoot, 'documents-unavailable'));
  try {
    const unavailable = await ready();
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { success: false, error: { code: 'SERVICE_NOT_READY', message: 'Service dependencies are unavailable.' } });
  } finally { await rename(join(env.uploadRoot, 'documents-unavailable'), documentsDirectory); }
  assert.equal((await ready()).status, 200);
  check('Readiness rejects unavailable evidence storage and recovers without exposing paths');

  // The suite owns this loopback PostgreSQL instance; no development database is stopped.
  const sourceCount = await prisma.claim.count();
  await maintenance.end();
  await restartDatabase('stop');
  try {
    assert.equal((await ready()).status, 503);
    assert.equal((await fetch(`${baseUrl}/api/v1/health`)).status, 200);
  } finally { await restartDatabase('start'); }
  assert.equal((await ready()).status, 200);
  assert.equal(await prisma.claim.count(), sourceCount);
  check('Database interruption returns not-ready, then recovers with saved claims intact');
  await stopApi();

  const backup = join(workspace, 'backup'), recovery = join(workspace, 'recovered');
  const backupKey = randomBytes(32).toString('hex');
  const user = await prisma.user.findFirstOrThrow();
  await prisma.staffPasswordResetToken.create({ data: { userId: user.userId, tokenHash: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 3600000) } });
  const receipts = await prisma.claimReceipt.findMany({ orderBy: { receiptId: 'asc' } });
  const before = Date.now();
  const summary = await createBackup({ destination: backup, databaseUrl: connection, uploadRoot: env.uploadRoot, fieldKey: env.fieldEncryptionKey, backupKey, writersStopped: true });
  assert.ok(summary.documents > 0);
  const restoredName = `${databaseName}_restore`;
  assert.match(restoredName, /^garantiyaid_acceptance_[a-f0-9]{32}_restore$/);
  const restoredUrl = new URL(connection); restoredUrl.pathname = `/${restoredName}`;
  const maintenanceUrl = new URL(connection); maintenanceUrl.pathname = '/postgres';
  const operator = new pg.Client({ connectionString: maintenanceUrl.toString() });
  await operator.connect();
  const restored = new pg.Client({ connectionString: restoredUrl.toString() });
  let created = false;
  try {
    await operator.query(`CREATE DATABASE "${restoredName}"`); created = true;
    await restored.connect();
    await assert.rejects(restoreBackup({ source: backup, destination: join(workspace, 'wrong-key'), databaseUrl: restoredUrl.toString(), backupKey: randomBytes(32).toString('hex') }));
    assert.equal((await restored.query("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")).rows[0].count, '0');
    const damaged = join(workspace, 'damaged'); await cp(backup, damaged, { recursive: true });
    const bytes = await readFile(join(damaged, 'database.dump.enc')); bytes[20] ^= 1; await writeFile(join(damaged, 'database.dump.enc'), bytes);
    await assert.rejects(restoreBackup({ source: damaged, destination: join(workspace, 'tampered'), databaseUrl: restoredUrl.toString(), backupKey }));
    assert.equal((await restored.query("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")).rows[0].count, '0');
    check('Wrong backup keys and tampered ciphertext fail before any database restore');

    const result = await restoreBackup({ source: backup, destination: recovery, databaseUrl: restoredUrl.toString(), backupKey });
    assert.equal(result.documents, summary.documents);
    await checkReadiness(restored, join(recovery, 'uploads', 'beneficiary-documents'));
    const fieldKey = JSON.parse(await readFile(join(recovery, 'field-key.json'), 'utf8')).FIELD_ENCRYPTION_KEY;
    assert.equal(fieldKey, env.fieldEncryptionKey);
    const restoredUser = (await restored.query('SELECT totp_secret FROM users WHERE user_id = $1', [user.userId])).rows[0];
    assert.equal(decryptTotpSecret(restoredUser.totp_secret), 'A'.repeat(32));
    const profiles = (await restored.query('SELECT beneficiary_id, consent_id, face_embedding FROM biometric_data')).rows;
    assert.ok(profiles.length > 0);
    for (const profile of profiles) assert.ok(decryptBiometricTemplate(profile.face_embedding, profile.beneficiary_id, profile.consent_id).length > 0);
    const signatures = (await restored.query('SELECT s.claim_id, c.beneficiary_id, c.distribution_id, s.encrypted_image, s.image_sha256 FROM claim_signatures s JOIN claims c ON c.claim_id = s.claim_id')).rows;
    assert.ok(signatures.length > 0);
    for (const signature of signatures) {
      const image = decryptSignatureImage(signature.encrypted_image, signature.claim_id, signature.beneficiary_id, signature.distribution_id);
      assert.equal(createHash('sha256').update(image).digest('hex'), signature.image_sha256);
    }
    for (const document of (await restored.query('SELECT file_path, checksum FROM beneficiary_documents')).rows) {
      assert.equal(await fileHash(join(recovery, document.file_path)), document.checksum);
    }
    const restoredReceipts = (await restored.query('SELECT receipt_id, snapshot, evidence_hash FROM claim_receipts ORDER BY receipt_id')).rows;
    assert.deepEqual(restoredReceipts, receipts.map(receipt => ({ receipt_id: receipt.receiptId, snapshot: receipt.snapshot, evidence_hash: receipt.evidenceHash })));
    check('Restored database, uploaded documents, receipts, TOTP, face templates and signatures match their saved evidence');
    assert.equal((await restored.query('SELECT count(*) FROM staff_sessions WHERE revoked_at IS NULL')).rows[0].count, '0');
    assert.equal((await restored.query('SELECT count(*) FROM staff_password_reset_tokens WHERE used_at IS NULL')).rows[0].count, '0');
    assert.equal((await restored.query('SELECT count(*) FROM staff_recovery_codes WHERE used_at IS NULL')).rows[0].count, '0');
    await assert.rejects(restoreBackup({ source: backup, destination: join(workspace, 'refused-overwrite'), databaseUrl: restoredUrl.toString(), backupKey }), /nonempty database/);
    assert.equal(await prisma.claim.count(), sourceCount);
    assert.equal((await readdir(documentsDirectory)).some(name => name.startsWith('.readiness-')), false);
    check('Recovery refuses database overwrite and invalidates old sessions, reset links and recovery codes');
    report.recovery = { ...result, elapsedMilliseconds: Date.now() - before, sourceDatabaseUnchanged: true, syntheticDataOnly: true };
  } finally {
    await restored.end();
    if (created) { await operator.query(`DROP DATABASE "${restoredName}" WITH (FORCE)`); report.recoveryDatabaseRemoved = true; }
    await operator.end();
  }
}
