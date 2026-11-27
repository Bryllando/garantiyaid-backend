import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { unlink } from 'node:fs/promises';
import { resolveBeneficiaryDocumentPath } from '../src/modules/documents/beneficiaryDocument.service.js';
import app from '../src/app.js';
import prisma from '../src/lib/prisma.js';
import { signAccessToken } from '../src/modules/auth/auth.service.js';

const actor = { userId: '11111111-1111-4111-8111-111111111111', role: 'DSWD_STAFF', isActive: true };
const programId = '22222222-2222-4222-8222-222222222222';
let server, origin;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}/api/v1/programs`; });
test.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
function replace(t, object, method, implementation) { const original = object[method]; object[method] = implementation; t.after(() => { object[method] = original; }); }
const request = (path, method, body) => fetch(origin + path, { method, headers: { Authorization: `Bearer ${signAccessToken(actor)}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('Other document names persist through create/read/edit and clear when Other is removed', async t => {
  let stored;
  const audits = [];
  const fundingAndCriteria = {
    budgetAmount: '10000.00',
    criteria: [{ criterionName: 'Adult applicant', fieldName: 'AGE', operator: 'GREATER_THAN_OR_EQUAL', expectedValue: 18 }],
  };
  const db = {
    program: {
      create: async ({ data, select }) => { assert.equal(select.otherRequiredDocumentName, true); stored = { ...data, programId, status: 'DRAFT', criteria: data.criteria.create }; return structuredClone(stored); },
      findFirst: async ({ select }) => { assert.equal(select.otherRequiredDocumentName, true); return structuredClone(stored); },
      update: async ({ data, select }) => { assert.equal(select.otherRequiredDocumentName, true); Object.assign(stored, data); return structuredClone(stored); },
    },
    auditLog: { create: async ({ data }) => { audits.push(data); return data; } },
  };
  replace(t, prisma.user, 'findUnique', async () => actor);
  replace(t, prisma.staffSession, 'findFirst', async () => ({ sessionId: 'synthetic-session' }));
  replace(t, prisma, '$transaction', async callback => callback(db));
  replace(t, prisma.program, 'findFirst', db.program.findFirst);

  const fields = { programName: 'Test assistance', programCode: 'TEST-NAME', programType: 'TEST', requiredDocumentTypes: ['OTHER'], otherRequiredDocumentName: ' Request letter ' };
  const incomplete = await request('', 'POST', fields);
  assert.equal(incomplete.status, 400);
  assert.deepEqual((await incomplete.json()).error.details.fields.map(({ field }) => field).sort(), ['budgetAmount', 'criteria']);
  assert.equal(stored, undefined);
  let response = await request('', 'POST', { ...fields, ...fundingAndCriteria });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).data.program.otherRequiredDocumentName, 'Request letter');
  response = await request(`/${programId}`, 'GET');
  assert.equal((await response.json()).data.program.otherRequiredDocumentName, 'Request letter');
  response = await request(`/${programId}`, 'PATCH', { description: 'Updated description' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.program.otherRequiredDocumentName, 'Request letter');
  response = await request(`/${programId}`, 'PATCH', { otherRequiredDocumentName: 'Certificate of indigency' });
  assert.equal((await response.json()).data.program.otherRequiredDocumentName, 'Certificate of indigency');
  for (const value of ['x'.repeat(151), 42]) {
    response = await request(`/${programId}`, 'PATCH', { otherRequiredDocumentName: value });
    assert.equal(response.status, 400);
    assert.equal(stored.otherRequiredDocumentName, 'Certificate of indigency');
  }
  response = await request(`/${programId}`, 'PATCH', { requiredDocumentTypes: ['VALID_ID'] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.program.otherRequiredDocumentName, null);
  assert.ok(audits.at(-1).details.changedFields.includes('otherRequiredDocumentName'));
  response = await request(`/${programId}`, 'PATCH', { otherRequiredDocumentName: 'Not an active requirement' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_OTHER_DOCUMENT');
  response = await request(`/${programId}`, 'PATCH', { requiredDocumentTypes: ['OTHER'], otherRequiredDocumentNames: ['Request letter', 'Certificate of indigency'] });
  assert.equal(response.status, 200);
  const saved = (await response.json()).data.program;
  assert.deepEqual(saved.otherRequiredDocumentNames, ['Request letter', 'Certificate of indigency']);
  assert.equal(saved.otherRequiredDocumentName, 'Request letter', 'legacy clients retain the first name');
  response = await request(`/${programId}`, 'PATCH', { otherRequiredDocumentName: 'Request letter', description: 'Old form payload' });
  assert.equal(response.status, 409, 'an old form must not silently remove the second requirement');
  assert.deepEqual(stored.otherRequiredDocumentNames, ['Request letter', 'Certificate of indigency']);
  for (const names of [['Request letter', ' request LETTER '], [''], ['x'.repeat(151)], Array.from({ length: 21 }, (_, i) => `Name ${i}`)]) {
    response = await request(`/${programId}`, 'PATCH', { otherRequiredDocumentNames: names });
    assert.equal(response.status, 400);
    const error = (await response.json()).error;
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.ok(error.details.fields[0].field.startsWith('otherRequiredDocumentNames'));
  }
  response = await request('', 'POST', { ...fundingAndCriteria, programName: 'TEST – Community Cash Assistance', programCode: 'TEST-CASH-2026-01', programType: 'CASH_ASSISTANCE', description: 'Practice program.', grantAmount: '1000.00', applicationStartDate: '2026-11-08', applicationEndDate: '2026-12-31', requiredDocumentTypes: ['VALID_ID', 'BARANGAY_CERTIFICATE', 'OTHER'], otherRequiredDocumentNames: ['Request letter', 'Certificate of indigency'] });
  assert.equal(response.status, 201, 'the complete manual example must pass real request validation');
});

test('program eligibility preview lists candidates without modifying beneficiary or enrollment records', async t => {
  const age = { criterionId: programId, criterionName: 'Adult', fieldName: 'AGE', operator: 'GREATER_THAN_OR_EQUAL', expectedValue: 18 };
  const applicant = { firstName: 'QA', lastName: 'Candidate', birthDate: new Date('1980-01-01'), barangay: { barangayName: 'QA barangay' },
    documents: [{ documentType: 'VALID_ID', reviewStatus: 'ACCEPTED' }] };
  let staff = actor;
  replace(t, prisma.user, 'findUnique', async () => staff);
  replace(t, prisma.staffSession, 'findFirst', async () => ({ sessionId: 'synthetic-session' }));
  replace(t, prisma.program, 'findFirst', async () => ({ criteria: [age], requiredDocumentTypes: ['VALID_ID'] }));
  replace(t, prisma.beneficiary, 'findMany', async ({ where, take }) => {
    assert.deepEqual(where, { status: 'ACTIVE', barangayId: actor.userId });
    assert.equal(take, 10);
    return [
      { ...applicant, beneficiaryId: 'adult' },
      { ...applicant, beneficiaryId: 'missing-document', documents: [] },
      { ...applicant, beneficiaryId: 'under-age', birthDate: new Date('2025-01-01') },
    ];
  });
  replace(t, prisma.beneficiary, 'count', async () => 3);
  const path = `/${programId}/eligibility-preview?barangayId=${actor.userId}&pageSize=10`;
  const response = await request(path, 'GET');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const { candidates, pagination } = (await response.json()).data;
  assert.deepEqual(candidates.map(({ status }) => status), ['ELIGIBLE', 'REVIEW_REQUIRED', 'INELIGIBLE']);
  assert.deepEqual(Object.keys(candidates[0]), ['beneficiaryId', 'firstName', 'lastName', 'barangayName', 'status']);
  assert.equal(pagination.total, 3);
  staff = { ...actor, role: 'BARANGAY_FACILITATOR', barangayId: actor.userId };
  const forbidden = await fetch(origin + path, { headers: { Authorization: `Bearer ${signAccessToken(staff)}` } });
  assert.equal(forbidden.status, 403);
});

test('named Other uploads persist their metadata through the real multipart endpoint', async t => {
  const uploader = { ...actor, role: 'SYSTEM_ADMIN' };
  let stored;
  replace(t, prisma.user, 'findUnique', async () => uploader);
  replace(t, prisma.staffSession, 'findFirst', async () => ({ sessionId: 'synthetic-session' }));
  replace(t, prisma.beneficiary, 'findFirst', async () => ({ beneficiaryId: programId, status: 'ACTIVE', barangayId: actor.userId }));
  replace(t, prisma, '$transaction', async callback => callback({
    beneficiaryDocument: { create: async ({ data, select }) => { assert.equal(select.documentName, true); stored = { ...data, documentId: actor.userId }; return stored; } },
    auditLog: { create: async () => ({}) },
  }));
  const body = new FormData();
  body.set('documentType', 'OTHER'); body.set('documentName', ' Request letter ');
  body.set('file', new Blob(['%PDF-1.4\nSynthetic test file'], { type: 'application/pdf' }), 'request-letter.pdf');
  try {
    const response = await fetch(`${origin.replace('/programs', '/beneficiaries')}/${programId}/documents`, { method: 'POST', headers: { Authorization: `Bearer ${signAccessToken(uploader)}` }, body });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).data.document.documentName, 'Request letter');
    assert.equal(stored.reviewStatus, 'SUBMITTED');
  } finally { if (stored) await unlink(resolveBeneficiaryDocumentPath(stored.filePath)); }
});
