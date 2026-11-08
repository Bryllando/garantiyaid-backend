import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBurialSchema, burialActionSchema } from '../src/modules/burial/burial.schemas.js';
import { assertBurialActionRole, assertBurialTransition, burialDocuments, burialLetterSnapshot, burialScope } from '../src/modules/burial/burial.service.js';

const barangay = { userId: randomUUID(), role: 'BARANGAY_FACILITATOR', barangayId: randomUUID() };
const reviewer = { userId: randomUUID(), role: 'DSWD_STAFF' };
const input = { beneficiaryId: randomUUID(), deceasedName: 'Sample Deceased', deathDate: '2026-01-01', relationship: 'Daughter', purpose: 'Assessment of funeral expenses.', receivingOffice: 'Sample municipal social welfare office', receivingAddress: 'Sample municipality', sendingOffice: 'Sample barangay', signatoryName: 'Designated officer', signatoryPosition: 'Authorized position', attachments: [] };
const record = { ...input, referralId: randomUUID(), createdById: barangay.userId, version: 2, status: 'IN_REVIEW', deathDate: new Date('2026-01-01'), beneficiary: { status: 'ACTIVE', firstName: 'Living', lastName: 'Applicant', address: 'Sample address' } };

test('burial input rejects impossible/future death dates, unknown fields, and repeated attachment IDs', () => {
  assert.equal(createBurialSchema.safeParse(input).success, true);
  for (const deathDate of ['2026-02-30', '9999-01-01', 'tomorrow']) assert.equal(createBurialSchema.safeParse({ ...input, deathDate }).success, false);
  assert.equal(createBurialSchema.safeParse({ ...input, status: 'ISSUED' }).success, false);
  const document = { documentId: randomUUID(), label: 'Death certificate' };
  assert.equal(createBurialSchema.safeParse({ ...input, attachments: [document, document] }).success, false);
  assert.equal(burialActionSchema.safeParse({ action: 'issue', version: 1, confirmed: false, reference: 'log-1' }).success, false);
  assert.equal(burialActionSchema.safeParse({ action: 'close', version: 1, outcome: 'APPROVED_BY_OFFICE', reference: '', note: '' }).success, false);
});
test('Barangay scope is mandatory and Admin cannot decide or issue burial referrals', () => {
  assert.deepEqual(burialScope(barangay), { beneficiary: { barangayId: barangay.barangayId } });
  assert.throws(() => burialScope({ ...barangay, barangayId: null }), error => error.statusCode === 403);
  for (const action of ['create', 'edit', 'submit', 'return', 'prepare', 'issue', 'close']) assert.throws(() => assertBurialActionRole({ role: 'SYSTEM_ADMIN' }, action), error => error.statusCode === 403);
  assert.throws(() => assertBurialActionRole(barangay, 'prepare'), error => error.statusCode === 403);
});
test('review and issuance enforce independent actors, current versions, active applicants and state order', () => {
  assert.doesNotThrow(() => assertBurialTransition(record, reviewer, 'prepare', 2));
  assert.throws(() => assertBurialTransition(record, { ...reviewer, userId: barangay.userId }, 'prepare', 2), error => error.code === 'INDEPENDENT_REVIEW_REQUIRED');
  assert.throws(() => assertBurialTransition(record, reviewer, 'prepare', 1), error => error.code === 'REFERRAL_CHANGED');
  assert.throws(() => assertBurialTransition(record, barangay, 'issue', 2), error => error.code === 'REFERRAL_STATUS_INVALID');
  assert.throws(() => assertBurialTransition({ ...record, beneficiary: { status: 'INACTIVE' } }, reviewer, 'prepare', 2), error => error.code === 'BENEFICIARY_INACTIVE');
  assert.throws(() => assertBurialTransition({ ...record, status: 'ISSUED' }, reviewer, 'return', 2), error => error.code === 'REFERRAL_STATUS_INVALID');
});
test('only this applicant’s current documents can be listed; ready letters require accepted evidence', async () => {
  const docId = randomUUID();
  const attachments = [{ documentId: docId, label: 'Death record' }];
  let documents = [];
  const tx = { beneficiaryDocument: { findMany: async ({ where }) => { assert.equal(where.beneficiaryId, input.beneficiaryId); return documents; } } };
  await assert.rejects(burialDocuments(tx, input.beneficiaryId, attachments), error => error.code === 'REFERRAL_DOCUMENT_INVALID');
  documents = [{ documentId: docId, reviewStatus: 'SUBMITTED' }];
  await assert.rejects(burialDocuments(tx, input.beneficiaryId, attachments, true), error => error.code === 'REFERRAL_DOCUMENT_REVIEW_REQUIRED');
  documents[0].reviewStatus = 'SUPERSEDED';
  await assert.rejects(burialDocuments(tx, input.beneficiaryId, attachments, true), error => error.code === 'REFERRAL_DOCUMENT_INVALID');
  documents[0].reviewStatus = 'REMOVED';
  await assert.rejects(burialDocuments(tx, input.beneficiaryId, attachments), error => error.code === 'REFERRAL_DOCUMENT_INVALID');
  documents[0].reviewStatus = 'ACCEPTED';
  assert.equal((await burialDocuments(tx, input.beneficiaryId, attachments, true))[0].label, 'Death record');
});
test('letter snapshots keep applicant/deceased separate and exclude unrelated identity/contact data', () => {
  const source = { ...record, beneficiary: { ...record.beneficiary, philsysNumber: 'PRIVATE-ID', contactNumber: 'PRIVATE-CONTACT' } };
  const snapshot = burialLetterSnapshot(source, [], new Date('2026-01-02'));
  source.beneficiary.firstName = 'Changed';
  assert.equal(snapshot.applicantName, 'Living Applicant');
  assert.equal(snapshot.deceasedName, 'Sample Deceased');
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE-'), false);
  assert.match(snapshot.reference, /^BR-/);
});
