import test from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../src/config/env.js';
import { beneficiaryImportDatabase } from './helpers/beneficiaryImportDatabase.js';
import { previewBeneficiaryImport, validateBeneficiaryImport, insertImportedBeneficiary } from '../src/modules/beneficiaries/beneficiaryImport.service.js';
import { startBeneficiaryImport, claimBeneficiaryImport, processBeneficiaryImportBatch, getBeneficiaryImportResults, listBeneficiaryImports, resumeBeneficiaryImport } from '../src/modules/beneficiaries/beneficiaryImportJob.service.js';
import { previewBeneficiaryImportSchema } from '../src/modules/beneficiaries/beneficiaryImport.schemas.js';

const barangayId = '11111111-1111-4111-8111-111111111111';
const otherBarangay = '22222222-2222-4222-8222-222222222222';
const programId = '33333333-3333-4333-8333-333333333333';
const user = { userId: 'admin-fixture', role: 'SYSTEM_ADMIN', isActive: true };
const row = (n = 0) => ({ sourceRow: n + 2, firstName: `Person ${n}`, middleName: '', lastName: 'Fixture', birthDate: '1990-01-12', sex: 'FEMALE', address: 'Test street', barangayId });
function setup(t) {
  const key = env.fieldEncryptionKey; env.fieldEncryptionKey = 'bc'.repeat(32); t.after(() => { env.fieldEncryptionKey = key; });
  const db = beneficiaryImportDatabase();
  db.state.users.push({ ...user });
  db.state.barangays.push({ barangayId, isActive: true, barangayName: 'Poblacion', city: 'Cebu' });
  db.state.programs.push({ programId, programCode: 'AID', programName: 'Fixture assistance', status: 'ACTIVE', requiredDocumentTypes: ['VALID_ID'] });
  return db;
}
async function start(db, rows, actor = user) {
  const review = await previewBeneficiaryImport(actor, rows, db);
  assert.equal(review.invalidCount, 0, JSON.stringify(review.rows.find(row => row.issues.length)?.issues));
  const req = { staffUser: actor, auth: { userId: actor.userId }, get: () => review.approvalId, validatedBody: { rows, approvalId: review.approvalId, confirmed: true } };
  return { job: await startBeneficiaryImport(req, db), req };
}

test('review rejects invalid fields, duplicate people across the entire file and protected-field injection', async t => {
  const db = setup(t);
  const rows = Array.from({ length: 101 }, (_, n) => row(n)); rows[100] = { ...rows[0], sourceRow: 102, email: 'different@example.test' };
  const checked = await previewBeneficiaryImport(user, rows, db);
  assert.equal(checked.invalidCount, 2); assert.equal(checked.approvalId, undefined);
  assert.equal(db.state.beneficiaries.length, 0);
  db.state.beneficiaries.push({ ...row(0), middleName: null, birthDate: new Date('1990-01-12') });
  assert.equal((await validateBeneficiaryImport([{ ...row(), email: 'new@example.test' }], user, db)).invalidCount, 1);
  for (const extra of [{ status: 'APPROVED' }, { passwordHash: 'x' }, { isVerified: true }, { enrollmentStatus: 'APPROVED' }]) assert.equal(previewBeneficiaryImportSchema.safeParse({ rows: [{ ...row(), ...extra }] }).success, false);
  for (const extra of [{ birthDate: '2026-02-30' }, { birthDate: '2999-01-01' }, { sex: '' }, { contactNumber: '1234' }, { barangayId: otherBarangay }]) assert.equal((await validateBeneficiaryImport([{ ...row(2), ...extra }], user, db)).invalidCount, 1);
  const invalidDate = await validateBeneficiaryImport([{ ...row(2), birthDate: '2026-02-30', programId }], user, db);
  assert.ok(invalidDate.rows[0].issues.every(issue => issue.startsWith('Birth date:')));
  assert.equal(previewBeneficiaryImportSchema.safeParse({ rows: Array.from({ length: 5001 }, (_, n) => row(n)) }).success, false);
});

test('1,001-row import commits in batches; retries and recovered results do not create duplicates', async t => {
  const db = setup(t);
  const rows = Array.from({ length: 1001 }, (_, n) => ({ ...row(n), ...(n % 2 ? { programId } : {}) }));
  const { job, req } = await start(db, rows);
  assert.equal((await startBeneficiaryImport(req, db)).replayed, true);
  assert.equal(db.state.jobs.length, 1); assert.ok(!db.state.jobs[0].encryptedRows.includes('Person'));
  await assert.rejects(() => getBeneficiaryImportResults(user, job.importId, db), { code: 'BENEFICIARY_IMPORT_PROCESSING' });
  for (let n = 0; n < 21; n++) { const claimed = await claimBeneficiaryImport(db); assert.ok(claimed); await processBeneficiaryImportBatch(claimed, db); }
  const result = await getBeneficiaryImportResults(user, job.importId, db);
  assert.equal(result.createdCount, 1001); assert.equal(result.processedCount, 1001); assert.equal(result.status, 'COMPLETED');
  assert.equal(db.state.enrollments.length, 500); assert.ok(db.state.enrollments.every(item => item.status === 'NEEDS_CORRECTION'));
  assert.ok(db.state.beneficiaries.every(item => !item.passwordHash && !item.isVerified));
  assert.equal(db.state.jobs[0].encryptedRows, null); assert.equal(db.state.batches.length, 21);
  assert.ok(!JSON.stringify(db.state.audits).includes('Person'));
  assert.equal((await previewBeneficiaryImport(user, rows, db)).invalidCount, 1001);
  assert.equal((await startBeneficiaryImport(req, db)).replayed, true);
});

test('a failed batch rolls back beneficiaries and enrollments; resume keeps previous records', async t => {
  const db = setup(t);
  const { job } = await start(db, Array.from({ length: 55 }, (_, n) => ({ ...row(n), programId })));
  await processBeneficiaryImportBatch(await claimBeneficiaryImport(db), db);
  let insertions = 0;
  await processBeneficiaryImportBatch(await claimBeneficiaryImport(db), db, { insert: async (...args) => {
    const result = await insertImportedBeneficiary(...args); if (++insertions === 2) throw new Error('fixture failure'); return result;
  } });
  assert.equal(db.state.beneficiaries.length, 50); assert.equal(db.state.enrollments.length, 50);
  const partial = await getBeneficiaryImportResults(user, job.importId, db); assert.equal(partial.status, 'FAILED'); assert.equal(partial.createdCount, 50);
  db.state.beneficiaries.push({ ...row(52), middleName: null, birthDate: new Date('1990-01-12') });
  await resumeBeneficiaryImport(user, job.importId, db);
  await processBeneficiaryImportBatch(await claimBeneficiaryImport(db), db);
  const result = await getBeneficiaryImportResults(user, job.importId, db);
  assert.equal(result.createdCount, 54); assert.equal(result.failedCount, 1); assert.equal(result.failures[0].sourceRow, 54);
});

test('facilitator scope, owner access, role changes and expired results are enforced', async t => {
  const db = setup(t);
  const actor = { userId: 'facilitator', role: 'BARANGAY_FACILITATOR', barangayId, isActive: true };
  db.state.users.push(actor);
  assert.equal((await validateBeneficiaryImport([{ ...row(), barangayId: otherBarangay }], actor, db)).invalidCount, 1);
  const { job } = await start(db, [row()], actor);
  actor.barangayId = otherBarangay;
  await processBeneficiaryImportBatch(await claimBeneficiaryImport(db), db);
  assert.equal(db.state.jobs[0].status, 'FAILED'); assert.equal(db.state.beneficiaries.length, 0);
  assert.equal((await listBeneficiaryImports(actor, db)).length, 0);
  await assert.rejects(() => getBeneficiaryImportResults(actor, job.importId, db), { code: 'BENEFICIARY_IMPORT_ACCESS_CHANGED' });
  await assert.rejects(() => getBeneficiaryImportResults(user, job.importId, db), { code: 'BENEFICIARY_IMPORT_NOT_FOUND' });
  actor.barangayId = barangayId;
  db.state.users.find(user => user.userId === actor.userId).barangayId = barangayId;
  await resumeBeneficiaryImport(actor, job.importId, db); await processBeneficiaryImportBatch(await claimBeneficiaryImport(db), db);
  assert.equal(db.state.beneficiaries.length, 1);
  db.state.jobs[0].expiresAt = new Date(0);
  await assert.rejects(() => getBeneficiaryImportResults(actor, job.importId, db), { code: 'BENEFICIARY_IMPORT_NOT_FOUND' });
  await assert.rejects(() => validateBeneficiaryImport([row()], { ...actor, role: 'DSWD_STAFF' }, db), { code: 'BENEFICIARY_IMPORT_ACCESS_CHANGED' });
});

test('program choices are rechecked; no-document applications are pending, never approved', async t => {
  const db = setup(t);
  db.state.programs[0].requiredDocumentTypes = [];
  const { job } = await start(db, [{ ...row(), programId }]);
  await processBeneficiaryImportBatch(await claimBeneficiaryImport(db), db);
  assert.equal((await getBeneficiaryImportResults(user, job.importId, db)).beneficiaries[0].enrollment.status, 'PENDING');
  db.state.programs[0].status = 'DRAFT';
  assert.equal((await previewBeneficiaryImport(user, [{ ...row(1), programId }], db)).invalidCount, 1);
  db.state.programs[0].status = 'ACTIVE'; db.state.programs[0].applicationEndDate = new Date('2020-01-01');
  assert.equal((await previewBeneficiaryImport(user, [{ ...row(1), programId }], db)).invalidCount, 1);
});

test('lost leases cannot commit; approval is bound to rows and barangay access', async t => {
  const db = setup(t); const { job, req } = await start(db, [row()]);
  const claim = await claimBeneficiaryImport(db); db.state.jobs[0].processingToken = 'another-worker';
  assert.equal(await processBeneficiaryImportBatch(claim, db), null); assert.equal(db.state.beneficiaries.length, 0);
  await assert.rejects(() => startBeneficiaryImport({ ...req, validatedBody: { ...req.validatedBody, rows: [row(5)] } }, db), { code: 'BENEFICIARY_IMPORT_CHANGED' });
  assert.equal(db.state.jobs[0].importId, job.importId);
});
