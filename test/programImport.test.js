import test from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../src/config/env.js';
import { programImportDatabase } from './helpers/programImportDatabase.js';
import { previewProgramImport, validateProgramImport, insertImportedProgram, importMoney } from '../src/modules/programs/programImport.service.js';
import { startProgramImport, claimProgramImport, processProgramImportBatch, getProgramImportResults, listProgramImports, resumeProgramImport } from '../src/modules/programs/programImportJob.service.js';
import { previewProgramImportSchema } from '../src/modules/programs/programImport.schemas.js';

const user = { userId: 'admin-fixture', role: 'SYSTEM_ADMIN', isActive: true };
const row = (n = 0) => ({ sourceRow: n + 2, programName: `Program ${n}`, programCode: `TEST-${n}`, programType: 'CASH', grantAmount: 'PHP 1,500.50', budgetAmount: '15,000.00', requiredDocumentTypes: ['VALID_ID'] });
function setup(t) {
  const key = env.fieldEncryptionKey; env.fieldEncryptionKey = 'bc'.repeat(32); t.after(() => { env.fieldEncryptionKey = key; });
  const db = programImportDatabase(); db.state.users.push({ ...user }); return db;
}
async function start(db, rows, actor = user) {
  const review = await previewProgramImport(actor, rows, db);
  assert.equal(review.invalidCount, 0, JSON.stringify(review.rows.find(row => row.issues.length)?.issues));
  const req = { staffUser: actor, auth: { userId: actor.userId }, get: () => review.approvalId, validatedBody: { rows, approvalId: review.approvalId, confirmed: true } };
  return { job: await startProgramImport(req, db), req };
}

test('money parsing preserves cents and rejects rounding, invalid separators and database overflow', () => {
  for (const [input, expected] of [['₱ 1,234.50', '1234.50'], ['PHP 0.01', '0.01'], ['000.1', '0.10'], ['', null], ['9999999999.99', '9999999999.99']]) assert.equal(importMoney(input, 'grantAmount'), expected);
  assert.equal(importMoney('999,999,999,999.99', 'budgetAmount'), '999999999999.99');
  for (const input of ['-1', '1e3', '1,23', 'NaN', '1.999', '1.234,00', '10000000000']) assert.throws(() => importMoney(input, 'grantAmount'));
  assert.throws(() => importMoney('1000000000000', 'budgetAmount'));
});

test('preview validates details, case-insensitive duplicate codes, dates, documents and protected fields', async t => {
  const db = setup(t);
  const rows = Array.from({ length: 101 }, (_, n) => row(n)); rows[100].programCode = 'test-0';
  const duplicate = await previewProgramImport(user, rows, db);
  assert.equal(duplicate.invalidCount, 2); assert.equal(duplicate.approvalId, undefined); assert.equal(db.state.programs.length, 0);
  db.state.programs.push({ programCode: 'test-2', status: 'CLOSED' });
  assert.equal((await validateProgramImport([row(2)], user, db)).invalidCount, 1);
  for (const extra of [{ status: 'ACTIVE' }, { createdById: 'other' }, { criteria: [] }]) assert.equal(previewProgramImportSchema.safeParse({ rows: [{ ...row(), ...extra }] }).success, false);
  for (const extra of [{ programCode: 'x' }, { programName: '' }, { programType: 'bad/type' }, { grantAmount: '1.999' }, { budgetAmount: '100' }, { applicationStartDate: '2026-02-30' }, { applicationStartDate: '2026-12-01', applicationEndDate: '2026-11-01' }, { requiredDocumentTypes: ['UNKNOWN'] }]) assert.equal((await validateProgramImport([{ ...row(), ...extra }], user, db)).invalidCount, 1, JSON.stringify(extra));
  const large = Array.from({ length: 5000 }, (_, n) => row(n + 100));
  assert.equal((await previewProgramImport(user, large, db)).validCount, 5000);
  assert.equal(previewProgramImportSchema.safeParse({ rows: [...large, row(6000)] }).success, false);
  assert.equal(previewProgramImportSchema.safeParse({ rows: [row(), row()] }).success, false);
});

test('1,001 programs commit in 21 batches as drafts with no criteria; retry never duplicates', async t => {
  const db = setup(t); const rows = Array.from({ length: 1001 }, (_, n) => row(n));
  const { job, req } = await start(db, rows);
  assert.equal((await startProgramImport(req, db)).replayed, true);
  assert.ok(!db.state.jobs[0].encryptedRows.includes('Program'));
  await assert.rejects(() => getProgramImportResults(user, job.importId, db), { code: 'PROGRAM_IMPORT_PROCESSING' });
  for (let n = 0; n < 21; n++) await processProgramImportBatch(await claimProgramImport(db), db);
  const result = await getProgramImportResults(user, job.importId, db);
  assert.equal(result.createdCount, 1001); assert.equal(result.status, 'COMPLETED'); assert.equal(result.programs.length, 1001);
  assert.ok(db.state.programs.every(item => item.status === 'DRAFT' && item.createdById === user.userId && !item.criteria && item.grantAmount === '1500.50'));
  assert.equal(db.state.jobs[0].encryptedRows, null); assert.equal(db.state.batches.length, 21);
  assert.equal(db.state.audits.filter(item => item.action === 'PROGRAM_CREATED').length, 1001);
  assert.equal((await previewProgramImport(user, rows, db)).invalidCount, 1001);
  assert.equal((await startProgramImport(req, db)).replayed, true);
});

test('failed batches roll back; resume preserves checkpoints and rechecks duplicate codes', async t => {
  const db = setup(t); const { job } = await start(db, Array.from({ length: 55 }, (_, n) => row(n)));
  await processProgramImportBatch(await claimProgramImport(db), db);
  let inserted = 0;
  await processProgramImportBatch(await claimProgramImport(db), db, { insert: async (...args) => { const saved = await insertImportedProgram(...args); if (++inserted === 2) throw new Error('fixture'); return saved; } });
  assert.equal(db.state.programs.length, 50); assert.equal(db.state.batches.length, 1);
  assert.equal((await getProgramImportResults(user, job.importId, db)).status, 'FAILED');
  db.state.programs.push({ ...row(52), status: 'ACTIVE' });
  await resumeProgramImport(user, job.importId, db); await processProgramImportBatch(await claimProgramImport(db), db);
  const result = await getProgramImportResults(user, job.importId, db);
  assert.equal(result.createdCount, 54); assert.equal(result.failedCount, 1); assert.equal(result.failures[0].sourceRow, 54);
  assert.equal(db.state.programs.find(item => item.programCode === 'TEST-52').status, 'ACTIVE');
});

test('owner, expiry, permission changes and worker leases protect imports', async t => {
  const db = setup(t); const actor = { ...user, role: 'DSWD_STAFF' };
  db.state.users[0].role = actor.role;
  const { job } = await start(db, [row()], actor);
  await assert.rejects(() => getProgramImportResults({ ...actor, userId: 'other' }, job.importId, db), { code: 'PROGRAM_IMPORT_NOT_FOUND' });
  for (const extra of [{ role: 'BARANGAY_FACILITATOR' }, { isActive: false }, { archivedAt: new Date() }]) await assert.rejects(() => previewProgramImport({ ...actor, ...extra }, [row()], db), { code: 'PROGRAM_IMPORT_ACCESS_CHANGED' });
  const oldClaim = await claimProgramImport(db);
  assert.equal(await claimProgramImport(db), null);
  db.state.jobs[0].leaseUntil = new Date(0);
  const newClaim = await claimProgramImport(db);
  assert.equal(await processProgramImportBatch(oldClaim, db), null); assert.equal(db.state.programs.length, 0);
  db.state.users[0].isActive = false;
  await processProgramImportBatch(newClaim, db); assert.equal(db.state.jobs[0].status, 'FAILED'); assert.equal(db.state.programs.length, 0);
  db.state.users[0].isActive = true;
  await resumeProgramImport(actor, job.importId, db); await processProgramImportBatch(await claimProgramImport(db), db);
  assert.equal(db.state.programs.length, 1);
  assert.equal((await listProgramImports(actor, db)).length, 1);
  db.state.jobs[0].expiresAt = new Date(0);
  await assert.rejects(() => getProgramImportResults(actor, job.importId, db), { code: 'PROGRAM_IMPORT_NOT_FOUND' });
  assert.equal((await listProgramImports(actor, db)).length, 0);
});

test('confirmation rejects changed rows, wrong keys, unconfirmed and expired reviews', async t => {
  const db = setup(t); const rows = [row()]; const review = await previewProgramImport(user, rows, db);
  const req = { auth: { userId: user.userId }, staffUser: user, get: () => review.approvalId, validatedBody: { rows, approvalId: review.approvalId, confirmed: true } };
  await assert.rejects(() => startProgramImport({ ...req, get: () => '11111111-1111-4111-8111-111111111111' }, db), { code: 'PROGRAM_IMPORT_CONFIRMATION' });
  await assert.rejects(() => startProgramImport({ ...req, validatedBody: { ...req.validatedBody, confirmed: false } }, db), { code: 'PROGRAM_IMPORT_CONFIRMATION' });
  await assert.rejects(() => startProgramImport({ ...req, validatedBody: { ...req.validatedBody, rows: [row(1)] } }, db), { code: 'PROGRAM_IMPORT_CHANGED' });
  Object.values(db.state.approvals)[0].expiresAt = new Date(0);
  await assert.rejects(() => startProgramImport(req, db), { code: 'PROGRAM_IMPORT_EXPIRED' });
  assert.equal(db.state.jobs.length, 0);
});
