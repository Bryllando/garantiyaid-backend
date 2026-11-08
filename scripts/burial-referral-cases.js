import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { encryptTotpSecret } from '../src/modules/auth/totp.service.js';

export async function runBurialCases({ prisma, baseUrl, report }) {
  const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
  const staff = {};
  async function request(role, path, { method = 'GET', body, form, key, status = 200 } = {}) {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      method, signal: AbortSignal.timeout(30000),
      headers: { ...(staff[role] ? { authorization: `Bearer ${staff[role].accessToken}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) },
      ...(form ? { body: form } : body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json();
    if (status !== null) assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(payload)}`);
    return { status: response.status, data: payload.data, error: payload.error, replayed: response.headers.get('idempotency-replayed') };
  }
  const post = (role, path, body, options = {}) => request(role, path, { method: 'POST', body, ...options });
  const areas = [];
  for (const barangayName of ['Synthetic North', 'Synthetic South']) areas.push(await prisma.barangay.create({ data: { barangayName, city: 'Test City', province: 'Test Province' } }));
  const password = `Burial!${randomBytes(12).toString('hex')}`;
  const passwordHash = await bcrypt.hash(password, 10);
  for (const [name, role, barangayId] of [['admin', 'SYSTEM_ADMIN', null], ['dswd', 'DSWD_STAFF', null], ['barangay', 'BARANGAY_FACILITATOR', areas[0].barangayId], ['barangay2', 'BARANGAY_FACILITATOR', areas[0].barangayId], ['outsider', 'BARANGAY_FACILITATOR', areas[1].barangayId]]) {
    const identifier = role === 'DSWD_STAFF' ? 'BURIAL-DSWD' : name;
    await prisma.user.create({ data: { employeeId: `BURIAL-${name.toUpperCase()}`, username: role === 'DSWD_STAFF' ? null : name, fullName: `Synthetic ${name}`, email: `${name}@example.test`, role, barangayId, passwordHash, mustChangePassword: false, totpEnabled: true, totpSecret: encryptTotpSecret('A'.repeat(32)) } });
    const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const digest = createHmac('sha1', Buffer.alloc(20)).update(counter).digest();
    const totpCode = String((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
    staff[name] = (await post(null, '/auth/login', { identifier, password, totpCode })).data;
    assert.ok(staff[name].accessToken);
  }
  const createPerson = async (firstName, role = 'barangay') => (await post(role, '/beneficiaries', { firstName, lastName: 'Synthetic', birthDate: '1990-01-01', sex: 'FEMALE', address: 'Synthetic address, Test City' }, { status: 201 })).data.beneficiary;
  async function upload(person, role = 'barangay') {
    const form = new FormData(); form.set('documentType', 'OTHER');
    form.set('file', new Blob(['%PDF-1.4\nSynthetic fixture only\n%%EOF'], { type: 'application/pdf' }), 'synthetic-document.pdf');
    return (await request(role, `/beneficiaries/${person.beneficiaryId}/documents`, { method: 'POST', form, status: 201 })).data.document;
  }
  const applicant = await createPerson('Maria');
  const document = await upload(applicant);
  const foreign = await createPerson('Other', 'outsider');
  const foreignDocument = await upload(foreign, 'outsider');
  const fields = { deceasedName: 'Juan Synthetic', deathDate: '2025-01-02', relationship: 'Spouse', sendingOffice: 'Synthetic Barangay Office', receivingOffice: 'Synthetic City Social Welfare Office', receivingAddress: 'Synthetic City Hall, Test City', signatoryName: 'Synthetic Authorized Officer', signatoryPosition: 'Designated officer (test)', purpose: 'For assessment of burial assistance under the receiving office procedure.', attachments: [{ documentId: document.documentId, label: 'Supporting document (synthetic)' }] };
  const input = { beneficiaryId: applicant.beneficiaryId, ...fields };
  await request(null, '/burial-referrals', { status: 401 });
  for (const role of ['admin', 'dswd']) await post(role, '/burial-referrals', input, { key: randomUUID(), status: 403 });
  await post('barangay', '/burial-referrals', { ...input, deathDate: '2999-01-01' }, { key: randomUUID(), status: 400 });
  await post('barangay', '/burial-referrals', { ...input, attachments: [{ documentId: foreignDocument.documentId, label: 'Wrong person' }] }, { key: randomUUID(), status: 409 });
  const createKey = randomUUID();
  let referral = (await post('barangay', '/burial-referrals', input, { key: createKey, status: 201 })).data.referral;
  const path = `/burial-referrals/${referral.referralId}`;
  const replay = await post('barangay', '/burial-referrals', input, { key: createKey, status: 201 });
  assert.equal(replay.replayed, 'true'); assert.equal(replay.data.referral.referralId, referral.referralId);
  await post('barangay', '/burial-referrals', { ...input, purpose: 'Changed request' }, { key: createKey, status: 409 });
  await request('outsider', path, { status: 404 });
  assert.equal((await request('outsider', '/burial-referrals')).data.pagination.total, 0);
  await post('outsider', `${path}/actions`, { action: 'submit', version: referral.version }, { key: randomUUID(), status: 404 });
  await prisma.user.update({ where: { userId: staff.barangay.user.userId }, data: { barangayId: areas[1].barangayId } });
  await post('barangay', '/burial-referrals', input, { key: createKey, status: 404 });
  await prisma.user.update({ where: { userId: staff.barangay.user.userId }, data: { barangayId: areas[0].barangayId } });
  check('Real auth, role and barangay scope, attachment ownership, validation and scoped retry replay');
  const act = async (role, action, extra = {}, status = 200) => {
    const result = await post(role, `${path}/actions`, { action, version: referral.version, ...extra }, { key: randomUUID(), status });
    if (status === 200) referral = result.data.referral;
    return result;
  };
  await act('barangay', 'issue', { confirmed: true, reference: 'Too early' }, 409);
  await act('barangay', 'submit');
  await act('barangay', 'prepare', { confirmed: true }, 403);
  await act('dswd', 'prepare', { confirmed: true }, 409);
  await act('dswd', 'return', { note: 'Correct the destination address.' });
  await request('barangay', path, { method: 'PATCH', body: { ...fields, version: 1 }, key: randomUUID(), status: 409 });
  referral = (await request('barangay', path, { method: 'PATCH', body: { ...fields, version: referral.version, receivingAddress: 'Corrected synthetic address' }, key: randomUUID() })).data.referral;
  await act('barangay', 'submit');
  await post('dswd', `/beneficiaries/${applicant.beneficiaryId}/documents/${document.documentId}/review`, { decision: 'ACCEPTED' });
  await act('dswd', 'prepare', { confirmed: true });
  assert.equal(referral.status, 'READY');
  assert.equal((await prisma.auditLog.findFirstOrThrow({ where: { recordId: referral.referralId, action: 'BURIAL_REFERRAL_RETURN' } })).details.note, 'Correct the destination address.');
  const snapshot = structuredClone(referral.letterSnapshot);
  await prisma.beneficiary.update({ where: { beneficiaryId: applicant.beneficiaryId }, data: { address: 'Updated live profile address' } });
  assert.deepEqual((await request('dswd', path)).data.referral.letterSnapshot, snapshot);
  check('Correction/resubmission, accepted-document gate and frozen reviewed letter with audit history');
  await act('barangay', 'issue', { reference: 'Missing confirmation' }, 400);
  const keys = [randomUUID(), randomUUID()];
  const bodies = keys.map((_, i) => ({ action: 'issue', version: referral.version, confirmed: true, reference: `SIGNED-TEST-${i}` }));
  const roles = ['barangay', 'barangay2'];
  const results = await Promise.all(roles.map((role, i) => post(role, `${path}/actions`, bodies[i], { key: keys[i], status: null })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const winner = results.findIndex(result => result.status === 200);
  referral = results[winner].data.referral;
  const repeated = await post(roles[winner], `${path}/actions`, bodies[winner], { key: keys[winner] });
  assert.equal(repeated.replayed, 'true'); assert.deepEqual(repeated.data.referral, referral);
  assert.equal(await prisma.auditLog.count({ where: { recordId: referral.referralId, action: 'BURIAL_REFERRAL_ISSUE' } }), 1);
  await request('barangay', path, { method: 'PATCH', body: { ...fields, version: referral.version }, key: randomUUID(), status: 409 });
  await act('admin', 'close', { outcome: 'OTHER', reference: 'Test', note: 'Test' }, 403);
  await act('barangay', 'close', { outcome: 'DECLINED_BY_OFFICE', reference: 'TEST-REPLY-01', note: 'Synthetic receiving-office response.' });
  assert.equal(referral.status, 'CLOSED'); assert.deepEqual(referral.letterSnapshot, snapshot);
  assert.equal(await prisma.claim.count(), 0); assert.equal(await prisma.transaction.count(), 0);
  await post('barangay', '/burial-referrals', { ...input, deceasedName: 'Another Synthetic', deathDate: '2025-02-01' }, { key: randomUUID(), status: 201 });
  const secondPage = (await request('admin', '/burial-referrals?page=2&pageSize=1')).data;
  assert.equal(secondPage.referrals.length, 1); assert.equal(secondPage.pagination.total, 2);
  check('Competing issuance, immutable issued records, recorded office response, multiple death cases and no financial side effects');
  const browserApplicant = await createPerson('Ana');
  return { staff, browserApplicant, fields, check, request, post };
}
