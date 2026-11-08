import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import app from '../src/app.js';
import prisma from '../src/lib/prisma.js';
import { signAccessToken } from '../src/modules/auth/auth.service.js';

const beneficiaryId = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';
const barangayId = '33333333-3333-4333-8333-333333333333';
let server, origin;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}/api/v1/beneficiaries/${beneficiaryId}/documents`; });
test.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));

test('removal is scoped, conditional, audited, repeatable and never removes reviewed or referral evidence', async t => {
  let actor = { userId: beneficiaryId, role: 'BARANGAY_FACILITATOR', barangayId, isActive: true };
  let document = { documentId, beneficiaryId, reviewStatus: 'SUBMITTED' }, linked = false, stale = false, conflict = false;
  const audits = [];
  function replace(object, method, implementation) { const original = object[method]; object[method] = implementation; t.after(() => { object[method] = original; }); }
  replace(prisma.user, 'findUnique', async () => actor);
  replace(prisma.staffSession, 'findFirst', async () => ({ sessionId: 'synthetic-session' }));
  replace(prisma.beneficiary, 'findFirst', async ({ where }) => where.barangayId && where.barangayId !== barangayId ? null : { beneficiaryId, barangayId });
  replace(prisma.beneficiaryDocument, 'findMany', async ({ where }) => { assert.equal(where.reviewStatus.not, 'REMOVED'); return document?.reviewStatus === 'REMOVED' ? [] : [document]; });
  replace(prisma.beneficiaryDocument, 'findFirst', async ({ where }) => { assert.equal(where.reviewStatus.not, 'REMOVED'); return document?.reviewStatus === 'REMOVED' ? null : document; });
  replace(prisma, '$transaction', async (callback, options) => {
    assert.equal(options.isolationLevel, 'Serializable');
    if (conflict) throw Object.assign(new Error('serialization conflict'), { code: 'P2034' });
    return callback({
      beneficiaryDocument: {
        findFirst: async ({ where }) => { assert.deepEqual(where, { beneficiaryId, documentId }); return document; },
        updateMany: async ({ where, data }) => {
          assert.equal(where.reviewStatus, document.reviewStatus);
          assert.equal(data.reviewStatus, 'REMOVED');
          if (stale) return { count: 0 };
          document = { ...document, ...data }; return { count: 1 };
        },
      },
      burialReferral: { findFirst: async ({ where }) => { assert.deepEqual(where.attachments.array_contains, [{ documentId }]); return linked ? { referralId: beneficiaryId } : null; } },
      auditLog: { create: async ({ data }) => { audits.push(data); return data; } },
    });
  });
  const request = (method = 'DELETE', suffix = '') => fetch(origin + suffix, { method, headers: { Authorization: `Bearer ${signAccessToken(actor)}` } });
  const remove = async (status, code) => {
    const response = await request('DELETE', `/${documentId}`);
    assert.equal(response.status, status);
    const payload = await response.json();
    if (code) assert.equal(payload.error.code, code);
    return payload;
  };
  actor = { ...actor, role: 'DSWD_STAFF' };
  await remove(403, 'FORBIDDEN');
  actor = { ...actor, role: 'BARANGAY_FACILITATOR', barangayId: documentId };
  await remove(404, 'BENEFICIARY_NOT_FOUND');
  actor.barangayId = barangayId;
  for (const reviewStatus of ['ACCEPTED', 'SUPERSEDED']) {
    document.reviewStatus = reviewStatus;
    await remove(409, 'DOCUMENT_NOT_REMOVABLE');
  }
  document.reviewStatus = 'SUBMITTED'; linked = true;
  await remove(409, 'DOCUMENT_IN_REFERRAL'); linked = false;
  stale = true; await remove(409, 'DOCUMENT_STATUS_CHANGED'); stale = false;
  conflict = true; await remove(409, 'DOCUMENT_STATUS_CHANGED'); conflict = false;
  assert.equal(audits.length, 0);
  assert.equal((await remove(200)).data.removed, true);
  assert.equal(document.reviewStatus, 'REMOVED');
  assert.equal(audits[0].action, 'BENEFICIARY_DOCUMENT_REMOVED');
  await remove(200);
  assert.equal(audits.length, 1, 'retry must not add another removal audit');
  assert.deepEqual((await (await request('GET')).json()).data.documents, []);
  assert.equal((await request('GET', `/${documentId}/download`)).status, 404);
  document = { documentId, beneficiaryId, reviewStatus: 'REJECTED' };
  actor.role = 'SYSTEM_ADMIN';
  await remove(200);
  assert.equal(audits[1].details.previousStatus, 'REJECTED');
  document = null;
  await remove(404, 'BENEFICIARY_DOCUMENT_NOT_FOUND');
  const invalid = await request('DELETE', '/invalid-id');
  assert.equal(invalid.status, 400);
});
