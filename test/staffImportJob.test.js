import test from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../src/config/env.js';
import { staffImportDatabase } from './helpers/staffImportDatabase.js';
import { previewStaffImport } from '../src/modules/users/staffImport.service.js';
import { startStaffImport, claimStaffImport, processStaffImportBatch, getStaffImport, getStaffImportResults, listStaffImports, resumeStaffImport } from '../src/modules/users/staffImportJob.service.js';
import { startStaffImportSchema, confirmStaffImportSchema } from '../src/modules/users/staffImport.schemas.js';
import { insertStaffAccount } from '../src/modules/users/user.creation.js';

const originalKey = env.fieldEncryptionKey;
test.before(() => { env.fieldEncryptionKey = 'ab'.repeat(32); });
test.after(() => { env.fieldEncryptionKey = originalKey; });
const deps = { prepare: async row => ({ temporaryPassword: `fixture-secret-${row.sourceRow}`, passwordHash: 'fixture-hash' }), dispatch: async () => {} };
const rowsFor = count => Array.from({ length: count }, (_, i) => ({ sourceRow: i + 2, fullName: `Test Staff ${i}`, email: `staff${i}@example.test`, role: 'DSWD_STAFF' }));
async function fixture(count = 101) {
  const db = staffImportDatabase();
  db.state.users.push({ userId: 'admin-test', role: 'SYSTEM_ADMIN', isActive: true, email: 'admin@example.test' });
  const rows = rowsFor(count);
  const { approvalId } = await previewStaffImport('admin-test', rows, db);
  const req = { auth: { userId: 'admin-test' }, validatedBody: { rows, approvalId, confirmed: true }, get: () => approvalId, ip: '127.0.0.1' };
  return { db, rows, req, job: await startStaffImport(req, db) };
}

test('bulk review accepts 5,000 staff, detects duplicates across batches and keeps synchronous confirmation bounded', async () => {
  const { req } = await fixture(5000);
  assert.equal(startStaffImportSchema.safeParse(req.validatedBody).success, true);
  assert.equal(confirmStaffImportSchema.safeParse(req.validatedBody).success, false);
  const rows = rowsFor(1001);
  rows[1000].email = rows[0].email;
  const review = await previewStaffImport('admin-test', rows, staffImportDatabase());
  assert.equal(review.invalidCount, 2);
  assert.equal(review.approvalId, undefined);
});

test('submission is durable, actor-bound and idempotent without exposing source data in job history', async () => {
  const { db, req, job } = await fixture();
  assert.equal(job.status, 'QUEUED');
  assert.equal(db.state.users.length, 1);
  assert.equal((await startStaffImport(req, db)).replayed, true);
  assert.equal(db.state.jobs.length, 1);
  await assert.rejects(startStaffImport({ ...req, validatedBody: { ...req.validatedBody, confirmed: false } }, db));
  await assert.rejects(startStaffImport({ ...req, validatedBody: { ...req.validatedBody, rows: rowsFor(1) } }, db), { code: 'STAFF_IMPORT_CHANGED' });
  await assert.rejects(getStaffImport('other-admin', job.importId, db), { code: 'STAFF_IMPORT_NOT_FOUND' });
  await assert.rejects(getStaffImportResults('other-admin', job.importId, db), { code: 'STAFF_IMPORT_NOT_FOUND' });
  assert.deepEqual(await listStaffImports('other-admin', db), []);
  assert.equal(JSON.stringify(await listStaffImports('admin-test', db)).includes('encryptedRows'), false);
  assert.equal(JSON.stringify(db.state.jobs).includes('staff0@example.test'), false);
});

test('1,001 staff run in bounded batches with precise progress, changed-row failures and protected credentials', async () => {
  const { db, job } = await fixture(1001);
  db.state.users.push({ email: 'staff999@example.test', userId: 'created-elsewhere' });
  let batches = 0;
  while (true) {
    const claimed = await claimStaffImport(db);
    if (!claimed) break;
    const result = await processStaffImportBatch(claimed, db, deps);
    assert.ok(result.processedCount - claimed.processedCount <= 50);
    batches++;
  }
  assert.equal(batches, 21);
  const result = await getStaffImportResults('admin-test', job.importId, db);
  assert.equal(result.processedCount, 1001);
  assert.equal(result.createdCount, 1000);
  assert.equal(result.failedCount, 1);
  assert.equal(result.failures[0].sourceRow, 1001);
  assert.equal(new Set(result.accounts.map(item => item.user.employeeId)).size, 1000);
  assert.equal(db.state.jobs[0].encryptedRows, null);
  assert.equal(JSON.stringify(db.state.batches).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(db.state.audits).includes('fixture-secret'), false);
  assert.equal(db.state.audits.filter(row => row.action === 'STAFF_IMPORT_COMPLETED').length, 1);
});

test('only one processor owns a batch, and an expired lease cannot write after restart recovery', async () => {
  const { db } = await fixture();
  const claims = await Promise.all([claimStaffImport(db), claimStaffImport(db)]);
  const oldClaim = claims.find(Boolean);
  assert.equal(claims.filter(Boolean).length, 1);
  db.state.jobs[0].leaseUntil = new Date(0);
  const newClaim = await claimStaffImport(db);
  assert.notEqual(newClaim.processingToken, oldClaim.processingToken);
  assert.equal(await processStaffImportBatch(oldClaim, db, deps), null);
  assert.equal(db.state.users.length, 1);
  await processStaffImportBatch(newClaim, db, deps);
  assert.equal(db.state.jobs[0].processedCount, 50);
});

test('a failed batch rolls back without losing earlier credentials and resumes without duplicates', async () => {
  const { db, job } = await fixture();
  await processStaffImportBatch(await claimStaffImport(db), db, deps);
  let inserts = 0;
  await processStaffImportBatch(await claimStaffImport(db), db, { ...deps, insert: async (...args) => {
    const result = await insertStaffAccount(...args);
    if (++inserts === 2) throw new Error('Interrupted write');
    return result;
  } });
  const partial = await getStaffImportResults('admin-test', job.importId, db);
  assert.equal(partial.status, 'FAILED');
  assert.equal(partial.processedCount, 50);
  assert.equal(db.state.users.length, 51);
  assert.equal(db.state.batches.length, 1);
  await resumeStaffImport('admin-test', job.importId, db);
  while (true) { const next = await claimStaffImport(db); if (!next) break; await processStaffImportBatch(next, db, deps); }
  const result = await getStaffImportResults('admin-test', job.importId, db);
  assert.equal(result.createdCount, 101);
  assert.deepEqual(result.accounts.slice(0, 50), partial.accounts);
  assert.equal(db.state.users.length, 102);
});

test('a claim cannot use an old row offset if another batch committed after its lookup', async () => {
  const { db } = await fixture();
  const findFirst = db.staffImportJob.findFirst;
  db.staffImportJob.findFirst = async args => {
    const candidate = await findFirst(args);
    db.state.jobs[0].processedCount = 50;
    return candidate;
  };
  assert.equal(await claimStaffImport(db), null);
  assert.equal(db.state.jobs[0].leaseUntil, null);
});

test('revoked administrator access stops processing and expired results cannot be retrieved', async () => {
  const { db, job } = await fixture(1);
  db.state.users[0].isActive = false;
  await processStaffImportBatch(await claimStaffImport(db), db, deps);
  assert.equal(db.state.jobs[0].status, 'FAILED');
  assert.match(db.state.jobs[0].lastError, /no longer authorized/);
  assert.equal(db.state.users.length, 1);
  db.state.jobs[0].expiresAt = new Date(0);
  await assert.rejects(getStaffImportResults('admin-test', job.importId, db), { code: 'STAFF_IMPORT_NOT_FOUND' });
  await assert.rejects(resumeStaffImport('admin-test', job.importId, db), { code: 'STAFF_IMPORT_NOT_FOUND' });
});
