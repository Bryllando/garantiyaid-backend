import test from 'node:test';
import assert from 'node:assert/strict';
import { previewBarangayImport, validateBarangayImport, confirmBarangayImport } from '../src/modules/barangays/barangayImport.service.js';
import { previewBarangayImportSchema, confirmBarangayImportSchema } from '../src/modules/barangays/barangayImport.schemas.js';
import { barangayImportDatabase } from './helpers/barangayImportDatabase.js';

const actor = '11111111-1111-4111-8111-111111111111';
const row = { sourceRow: 3, barangayName: 'San Nicolas', barangayCode: '00123', city: 'Cebu City', province: 'Cebu' };
const request = (rows, approvalId, userId = actor) => ({ auth: { userId }, validatedBody: { rows, approvalId, confirmed: true }, get: name => name === 'idempotency-key' ? approvalId : undefined, ip: '127.0.0.1' });

test('barangay review rejects duplicates across file and existing inactive records without writing barangays', async () => {
  const db = barangayImportDatabase();
  db.state.barangays.push({ ...row, isActive: false });
  const review = await previewBarangayImport(actor, [
    { ...row, barangayName: ' SAN   NICOLAS ', barangayCode: 'other' },
    { ...row, sourceRow: 4, barangayName: 'Other place' },
    { ...row, sourceRow: 5, barangayCode: 'dup', city: 'Another city' },
    { ...row, sourceRow: 6, barangayCode: 'DUP', city: 'Another city' },
    { ...row, sourceRow: 7, barangayCode: '', province: '' },
  ], db);
  assert.equal(review.invalidCount, 5);
  assert.match(review.rows[0].issues.join(' '), /already exists/);
  assert.match(review.rows[1].issues.join(' '), /inactive/);
  assert.match(review.rows[2].issues.join(' '), /more than once/);
  assert.match(review.rows[4].issues.join(' '), /Province/);
  assert.equal(review.approvalId, undefined);
  assert.equal(Object.keys(db.state.approvals).length, 0);
  assert.equal(db.state.barangays.length, 1);
  assert.equal((await validateBarangayImport([{ ...row, barangayCode: '', city: 'New city' }], db)).validCount, 1);
});

test('confirmation adds active barangays with audit records and safely replays a lost response', async () => {
  const db = barangayImportDatabase();
  const rows = [row, { ...row, sourceRow: 4, barangayName: 'Other barangay', barangayCode: '' }];
  const review = await previewBarangayImport(actor, rows, db);
  assert.equal(db.state.barangays.length, 0);
  const result = await confirmBarangayImport(request(rows, review.approvalId), db);
  assert.equal(result.createdCount, 2);
  assert.ok(result.barangays.every(item => item.barangay.isActive));
  assert.equal(result.barangays[0].barangay.barangayCode, '00123');
  assert.equal(db.state.audits.filter(entry => entry.action === 'BARANGAY_CREATED').length, 2);
  const repeated = await confirmBarangayImport(request(rows, review.approvalId), db);
  assert.equal(repeated.replayed, true);
  assert.deepEqual(repeated.barangays, result.barangays);
  assert.equal(db.state.barangays.length, 2);
  assert.equal(db.state.audits.length, 3);
});

test('confirmation rejects edited, expired, unapproved and another administrator’s reviewed rows', async () => {
  const db = barangayImportDatabase();
  const { approvalId } = await previewBarangayImport(actor, [row], db);
  await assert.rejects(confirmBarangayImport(request([{ ...row, city: 'Changed' }], approvalId), db), { code: 'BARANGAY_IMPORT_CHANGED' });
  await assert.rejects(confirmBarangayImport(request([row], approvalId, '22222222-2222-4222-8222-222222222222'), db), { code: 'BARANGAY_IMPORT_EXPIRED' });
  const unconfirmed = request([row], approvalId); unconfirmed.validatedBody.confirmed = false;
  await assert.rejects(confirmBarangayImport(unconfirmed, db), { code: 'BARANGAY_IMPORT_CONFIRMATION' });
  const wrongKey = request([row], approvalId); wrongKey.get = () => '33333333-3333-4333-8333-333333333333';
  await assert.rejects(confirmBarangayImport(wrongKey, db), { code: 'BARANGAY_IMPORT_CONFIRMATION' });
  Object.values(db.state.approvals)[0].expiresAt = new Date(0);
  await assert.rejects(confirmBarangayImport(request([row], approvalId), db), { code: 'BARANGAY_IMPORT_EXPIRED' });
  assert.equal(db.state.barangays.length, 0);
});

test('confirmation rechecks current records and rolls back all writes if a later row fails', async () => {
  const db = barangayImportDatabase();
  const rows = [row, { ...row, sourceRow: 4, barangayName: 'Second', barangayCode: '00456' }];
  const { approvalId } = await previewBarangayImport(actor, rows, db);
  db.state.barangays.push({ ...row, isActive: true });
  await assert.rejects(confirmBarangayImport(request(rows, approvalId), db), { code: 'BARANGAY_IMPORT_INVALID' });
  db.state.barangays.length = 0;
  const create = db.barangay.create;
  db.barangay.create = async args => { if (args.data.barangayCode === '00456') throw Object.assign(new Error('Concurrent insert'), { code: 'P2002' }); return create(args); };
  await assert.rejects(confirmBarangayImport(request(rows, approvalId), db), { code: 'BARANGAY_IMPORT_CONCURRENT' });
  assert.equal(db.state.barangays.length, 0);
  assert.equal(db.state.audits.length, 0);
  assert.equal(Object.values(db.state.approvals)[0].responseStatus, 200);
});

test('barangay payload boundaries reject status injection, repeated source rows and files over 500 rows', () => {
  assert.equal(previewBarangayImportSchema.safeParse({ rows: [row] }).success, true);
  for (const rows of [[{ ...row, isActive: false }], [row, row], Array.from({ length: 501 }, (_, index) => ({ ...row, sourceRow: index + 3 }))]) assert.equal(previewBarangayImportSchema.safeParse({ rows }).success, false);
  assert.equal(confirmBarangayImportSchema.safeParse({ rows: [row], approvalId: actor, confirmed: false }).success, false);
});
