import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/config/env.js";
import { previewStaffImportSchema, confirmStaffImportSchema } from "../src/modules/users/staffImport.schemas.js";
import { validateStaffImport, previewStaffImport, confirmStaffImport, encryptImportHandoff, decryptImportHandoff } from "../src/modules/users/staffImport.service.js";
import { insertStaffAccount } from "../src/modules/users/user.creation.js";
import { staffImportDatabase } from "./helpers/staffImportDatabase.js";

const originalKey = env.fieldEncryptionKey;
test.before(() => { env.fieldEncryptionKey = 'ab'.repeat(32); });
test.after(() => { env.fieldEncryptionKey = originalKey; });
const barangayId = '11111111-1111-4111-8111-111111111111';
const row = (overrides = {}) => ({ sourceRow: 2, fullName: 'Maria Santos', email: 'maria@example.test', role: 'DSWD_STAFF', ...overrides });
const req = (approvalId, rows, userId = 'admin-test') => ({ auth: { userId }, validatedBody: { rows, approvalId, confirmed: true }, get: name => name === 'idempotency-key' ? approvalId : undefined, ip: '127.0.0.1' });
const dependencies = { prepare: async value => ({ temporaryPassword: `fixture-secret-${value.sourceRow}`, passwordHash: 'fixture-hash' }), dispatch: async () => {} };

test('import schema bounds batches and rejects credential, ID and privilege injection', () => {
  assert.equal(previewStaffImportSchema.safeParse({ rows: [row()] }).success, true);
  for (const rows of [[], Array.from({ length: 5001 }, (_, i) => row({ sourceRow: i + 2 })), [row(), row()], [row({ passwordHash: 'x' })], [row({ employeeId: 'ADMIN-1' })], [row({ isActive: true })]]) {
    assert.equal(previewStaffImportSchema.safeParse({ rows }).success, false);
  }
  assert.equal(confirmStaffImportSchema.safeParse({ rows: [row()], confirmed: true }).success, false);
});

test('preview uses manual-account validation, normalizes contact details and never writes accounts', async () => {
  const db = staffImportDatabase();
  db.state.barangays.push({ barangayId, barangayName: 'Poblacion', city: 'Cebu City', isActive: true });
  const review = await previewStaffImport('admin-test', [row({ email: ' MARIA@EXAMPLE.TEST ', contactNumber: '0917 123 4567' }), row({ sourceRow: 3, email: 'other@example.test', role: 'BARANGAY_FACILITATOR', username: 'other.staff', barangayId })], db);
  assert.equal(review.invalidCount, 0);
  assert.equal(review.rows[0].record.email, 'maria@example.test');
  assert.equal(review.rows[0].record.contactNumber, '+639171234567');
  assert.equal(review.rows[1].barangayLabel, 'Poblacion, Cebu City');
  assert.ok(review.approvalId);
  assert.equal(db.state.users.length, 0);
  assert.equal(db.state.notifications.length, 0);
});

test('preview reports all row errors, internal/existing/archived duplicates and inactive barangays', async () => {
  const db = staffImportDatabase();
  db.state.users.push({ email: 'existing@example.test', username: 'existing.staff', employeeId: 'BSTF-0010', archivedAt: new Date() });
  db.state.barangays.push({ barangayId, isActive: false });
  const review = await previewStaffImport('admin-test', [
    row({ email: 'EXISTING@example.test', role: 'SYSTEM_ADMIN' }),
    row({ sourceRow: 3, email: 'duplicate@example.test', role: 'BARANGAY_FACILITATOR', username: 'bstf-0010', barangayId }),
    row({ sourceRow: 4, email: 'DUPLICATE@example.test', role: 'BARANGAY_FACILITATOR', username: 'existing.staff', barangayId }),
    row({ sourceRow: 5, fullName: '', email: 'bad-email', role: 'BARANGAY_FACILITATOR' }),
  ], db);
  assert.equal(review.invalidCount, 4);
  assert.equal(review.approvalId, undefined);
  assert.match(review.rows[0].issues.join(' '), /existing account/);
  assert.match(review.rows[1].issues.join(' '), /more than once.*already used.*active barangay/);
  assert.ok(review.rows[3].issues.length >= 3);
  assert.equal(Object.keys(db.state.approvals).length, 0);
});

test('confirmation binds actor, reviewed payload, key and explicit consent', async () => {
  const db = staffImportDatabase();
  const rows = [row()];
  const { approvalId } = await previewStaffImport('admin-test', rows, db);
  await assert.rejects(confirmStaffImport(req(approvalId, rows, 'other-admin'), db, dependencies), { code: 'STAFF_IMPORT_EXPIRED' });
  await assert.rejects(confirmStaffImport(req(approvalId, [row({ role: 'SYSTEM_ADMIN' })]), db, dependencies), { code: 'STAFF_IMPORT_CHANGED' });
  const request = req(approvalId, rows);
  await assert.rejects(confirmStaffImport({ ...request, validatedBody: { ...request.validatedBody, confirmed: false } }, db, dependencies), { code: 'STAFF_IMPORT_CONFIRMATION' });
  await assert.rejects(confirmStaffImport({ ...request, get: () => null }, db, dependencies), { code: 'IDEMPOTENCY_KEY_REQUIRED' });
  Object.values(db.state.approvals)[0].expiresAt = new Date(0);
  await assert.rejects(confirmStaffImport(request, db, dependencies), { code: 'STAFF_IMPORT_EXPIRED' });
  assert.equal(db.state.users.length, 0);
});

test('atomic import reuses account creation, audit and onboarding; concurrent retries recover the same credentials', async () => {
  const db = staffImportDatabase();
  const rows = [row(), row({ sourceRow: 3, email: 'second@example.test' })];
  const { approvalId } = await previewStaffImport('admin-test', rows, db);
  let dispatched = 0;
  const deps = { ...dependencies, dispatch: async () => { dispatched++; } };
  const [first, second] = await Promise.all([confirmStaffImport(req(approvalId, rows), db, deps), confirmStaffImport(req(approvalId, rows), db, deps)]);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(first.accounts, second.accounts);
  assert.equal(db.state.users.length, 2);
  assert.ok(first.accounts.every(account => account.user.mustChangePassword && account.user.isActive && !account.user.passwordHash));
  assert.equal(db.state.audits.filter(audit => audit.action === 'STAFF_ACCOUNT_CREATED').length, 2);
  assert.equal(db.state.audits.filter(audit => audit.action === 'STAFF_IMPORT_COMPLETED').length, 1);
  assert.equal(db.state.notifications.length, 2);
  assert.equal(dispatched, 2);
  assert.ok(!JSON.stringify(db.state.approvals).includes('fixture-secret-'));
  assert.ok(!JSON.stringify(db.state.audits).includes('fixture-secret-'));
});

test('retry recovers credentials when another confirmation commits during validation', async () => {
  const db = staffImportDatabase();
  const rows = [row()];
  const { approvalId } = await previewStaffImport('admin-test', rows, db);
  const findMany = db.user.findMany;
  let original;
  db.user.findMany = async args => {
    db.user.findMany = findMany;
    original = await confirmStaffImport(req(approvalId, rows), db, dependencies);
    return findMany(args);
  };
  const retry = await confirmStaffImport(req(approvalId, rows), db, dependencies);
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.accounts, original.accounts);
  assert.equal(db.state.users.length, 1);
});

test('a late write failure rolls back every account, audit and notification and permits the same retry', async () => {
  const db = staffImportDatabase();
  const rows = [row(), row({ sourceRow: 3, email: 'second@example.test' })];
  const { approvalId } = await previewStaffImport('admin-test', rows, db);
  let count = 0;
  await assert.rejects(confirmStaffImport(req(approvalId, rows), db, { ...dependencies, insert: async (...args) => {
    const inserted = await insertStaffAccount(...args);
    if (++count === 2) throw new Error('Second write failed');
    return inserted;
  } }), /Second write failed/);
  assert.equal(db.state.users.length, 0);
  assert.equal(db.state.audits.length, 0);
  assert.equal(db.state.notifications.length, 0);
  assert.equal((await confirmStaffImport(req(approvalId, rows), db, dependencies)).createdCount, 2);
});

test('changed barangays and new account conflicts invalidate a preview without partial writes', async () => {
  const db = staffImportDatabase();
  db.state.barangays.push({ barangayId, barangayName: 'Poblacion', city: 'Cebu', isActive: true });
  const rows = [row({ role: 'BARANGAY_FACILITATOR', username: 'maria.staff', barangayId })];
  const { approvalId } = await previewStaffImport('admin-test', rows, db);
  db.state.barangays[0].isActive = false;
  await assert.rejects(confirmStaffImport(req(approvalId, rows), db, dependencies), { code: 'STAFF_IMPORT_INVALID' });
  assert.equal(db.state.users.length, 0);
  db.state.barangays[0].isActive = true;
  db.state.users.push({ email: 'maria@example.test', employeeId: 'OTHER-0001' });
  const review = await validateStaffImport(rows, db);
  assert.equal(review.invalidCount, 1);
});

test('credential handoff rejects tampering and another actor or batch context', () => {
  const encrypted = encryptImportHandoff({ password: 'fixture-only' }, 'admin:batch');
  assert.deepEqual(decryptImportHandoff(encrypted, 'admin:batch'), { password: 'fixture-only' });
  assert.throws(() => decryptImportHandoff(encrypted, 'another:batch'));
  const pieces = encrypted.split('.');
  pieces[2] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decryptImportHandoff(pieces.join('.'), 'admin:batch'));
});
