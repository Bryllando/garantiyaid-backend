import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import pg from 'pg';
import { encryptTotpSecret } from '../src/modules/auth/totp.service.js';

// The simulated processor deliberately accepts synthetic bytes; these are not face photos.
export function syntheticCapture(seed) {
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...Array.from({ length: 40 }, (_, i) => createHash('sha512').update(`${seed}:${i}`).digest())]);
}

export async function runIntegratedCases({ prisma, baseUrl, report }) {
  const check = (name) => { report.checks.push(name); console.log(`PASS ${name}`); };
  const staff = {};
  async function request(role, path, { method = 'GET', body, form, key, status = 200, code } = {}) {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      method, signal: AbortSignal.timeout(30000),
      headers: { ...(staff[role] ? { authorization: `Bearer ${staff[role].accessToken}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) },
      ...(form ? { body: form } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json();
    if (status !== null) assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(payload)}`);
    if (code) assert.equal(payload.error?.code, code);
    return { status: response.status, data: payload.data, error: payload.error, replayed: response.headers.get('idempotency-replayed') };
  }
  const post = (role, path, body = {}, options = {}) => request(role, path, { method: 'POST', body, ...options });
  const barangays = [];
  for (const label of ['Acceptance North', 'Acceptance South']) {
    barangays.push(await prisma.barangay.create({ data: { barangayName: label, city: 'Test City', province: 'Test Province' } }));
  }
  const password = `Acceptance!${randomBytes(12).toString('hex')}`;
  const passwordHash = await bcrypt.hash(password, 10);
  for (const [name, role, barangayId] of [
    ['admin', 'SYSTEM_ADMIN', null], ['admin2', 'SYSTEM_ADMIN', null],
    ['dswd', 'DSWD_STAFF', null], ['dswd2', 'DSWD_STAFF', null],
    ['barangay', 'BARANGAY_FACILITATOR', barangays[0].barangayId],
    ['barangay2', 'BARANGAY_FACILITATOR', barangays[0].barangayId],
    ['outsider', 'BARANGAY_FACILITATOR', barangays[1].barangayId],
  ]) {
    const identifier = role === 'DSWD_STAFF' ? `TEST-${name.toUpperCase()}` : name;
    await prisma.user.create({ data: { employeeId: `TEST-${name.toUpperCase()}`, username: role === 'DSWD_STAFF' ? null : name, fullName: `Acceptance ${name}`, email: `${name}@example.test`, role, barangayId, passwordHash, mustChangePassword: false, totpEnabled: true, totpSecret: encryptTotpSecret('A'.repeat(32)) } });
    const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const digest = createHmac('sha1', Buffer.alloc(20)).update(counter).digest();
    const totpCode = String((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
    const first = await post(null, '/auth/login', { identifier, password });
    assert.equal(first.data.requiresTotp, true);
    staff[name] = (await post(null, '/auth/login', { identifier, password, totpCode })).data;
    assert.ok(staff[name].accessToken);
    assert.equal((await request(name, '/auth/me')).data.user.role, role);
  }
  check('Real password/TOTP authentication and database-backed staff sessions');

  async function competingBeneficiaryWrites(operations) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const lock = await pool.connect();
    let pending, waiting = 0;
    try {
      await lock.query('BEGIN');
      // Let both duplicate checks finish before either write can acquire its table lock.
      await lock.query('LOCK TABLE beneficiaries IN SHARE MODE');
      pending = Promise.all(operations.map(operation => operation()));
      for (let attempt = 0; attempt < 100 && waiting < operations.length; attempt++) {
        waiting = Number((await pool.query("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%beneficiaries%' AND (query ILIKE '%INSERT%' OR query ILIKE '%UPDATE%')")).rows[0].count);
        if (waiting < operations.length) await new Promise(resolve => setTimeout(resolve, 50));
      }
    } finally { await lock.query('COMMIT'); lock.release(); await pool.end(); }
    const results = await pending;
    assert.equal(waiting, operations.length, 'Both writes must reach the race barrier.');
    return results;
  }
  const registrationInput = { firstName: 'Synthetic Maria Elena', middleName: 'Reyes', lastName: 'Concurrent', birthDate: '1990-01-01', sex: 'FEMALE', address: 'Synthetic identity-race address' };
  const registrations = await competingBeneficiaryWrites(['barangay', 'barangay2'].map(role => () => post(role, '/beneficiaries', registrationInput, { status: null })));
  assert.deepEqual(registrations.map(result => result.status).sort(), [201, 409]);
  assert.equal(await prisma.beneficiary.count({ where: { firstName: registrationInput.firstName, lastName: registrationInput.lastName, birthDate: new Date(registrationInput.birthDate), barangayId: barangays[0].barangayId } }), 1);
  const registeredPerson = registrations.find(result => result.status === 201).data.beneficiary;
  await post('barangay', '/beneficiaries', registrationInput, { status: 409, code: 'POSSIBLE_DUPLICATE_BENEFICIARY' });
  for (const search of ['SYNTHETIC MARIA  ELENA REYES CONCURRENT', 'Reyes Concurrent Maria Elena Synthetic', 'Reyes']) {
    const matches = (await request('barangay', `/beneficiaries?search=${encodeURIComponent(search)}`)).data.beneficiaries;
    assert.ok(matches.some(match => match.beneficiaryId === registeredPerson.beneficiaryId), search);
  }
  assert.equal((await request('outsider', `/beneficiaries?search=${encodeURIComponent(registrationInput.firstName)}`)).data.pagination.total, 0);
  check('Concurrent registrations cannot create duplicate people; full-name and middle-name searches retain Barangay scope');
  const other = (await post('barangay', '/beneficiaries', { ...registrationInput, firstName: 'Synthetic Other', birthDate: '1991-01-01' }, { status: 201 })).data.beneficiary;
  const editIdentity = { firstName: 'Synthetic Target', middleName: 'Shared', lastName: 'Identity', birthDate: '1980-01-01' };
  const edits = await competingBeneficiaryWrites([registeredPerson, other].map((record, index) => () => request(['barangay', 'barangay2'][index], `/beneficiaries/${record.beneficiaryId}`, { method: 'PATCH', body: editIdentity, status: null })));
  assert.deepEqual(edits.map(result => result.status).sort(), [200, 409]);
  assert.equal(await prisma.beneficiary.count({ where: { ...editIdentity, birthDate: new Date(editIdentity.birthDate), barangayId: barangays[0].barangayId } }), 1);
  check('Concurrent edits cannot turn separate beneficiary records into the same identity');

  const { previewBeneficiaryImport } = await import('../src/modules/beneficiaries/beneficiaryImport.service.js');
  const { startBeneficiaryImport, claimBeneficiaryImport, processBeneficiaryImportBatch, resumeBeneficiaryImport } = await import('../src/modules/beneficiaries/beneficiaryImportJob.service.js');
  const importActor = await prisma.user.findUniqueOrThrow({ where: { userId: staff.barangay.user.userId } });
  const importPerson = { ...registrationInput, firstName: 'Synthetic Imported Race', barangayId: barangays[0].barangayId };
  const importRows = [{ sourceRow: 2, ...importPerson }];
  const importReview = await previewBeneficiaryImport(importActor, importRows);
  const importJob = await startBeneficiaryImport({ staffUser: importActor, auth: { userId: importActor.userId }, get: () => importReview.approvalId, validatedBody: { rows: importRows, approvalId: importReview.approvalId, confirmed: true }, ip: '127.0.0.1' });
  const importClaim = await claimBeneficiaryImport();
  const importRace = await competingBeneficiaryWrites([
    () => post('barangay2', '/beneficiaries', importPerson, { status: null }),
    () => processBeneficiaryImportBatch(importClaim),
  ]);
  assert.ok([201, 409].includes(importRace[0].status));
  assert.equal(await prisma.beneficiary.count({ where: { firstName: importPerson.firstName, lastName: importPerson.lastName, barangayId: importPerson.barangayId } }), 1);
  if ((await prisma.beneficiaryImportJob.findUniqueOrThrow({ where: { importId: importJob.importId } })).status === 'FAILED') {
    await resumeBeneficiaryImport(importActor, importJob.importId);
    await processBeneficiaryImportBatch(await claimBeneficiaryImport());
  }
  const finishedImport = await prisma.beneficiaryImportJob.findUniqueOrThrow({ where: { importId: importJob.importId } });
  assert.equal(finishedImport.status, 'COMPLETED');
  assert.equal(finishedImport.createdCount + finishedImport.failedCount, 1);
  check('A simultaneous manual registration and import create one person; interrupted import can resume safely');

  const program = (await post('dswd', '/programs', {
    programName: 'Acceptance assistance', programCode: 'ACCEPTANCE-1', programType: 'CASH_ASSISTANCE', grantAmount: 1500, budgetAmount: 150000, requiredDocumentTypes: ['VALID_ID'],
    criteria: [{ criterionName: 'Adult applicant', fieldName: 'AGE', operator: 'GREATER_THAN_OR_EQUAL', expectedValue: 18 }],
  }, { status: 201 })).data.program;
  await post('dswd', `/programs/${program.programId}/activate`);
  let serial = 0;
  async function approvedPerson(submitter = 'barangay') {
    const beneficiary = (await post('barangay', '/beneficiaries', { firstName: `Synthetic${++serial}`, lastName: 'Acceptance', birthDate: '1990-01-01', sex: 'FEMALE', address: 'Synthetic acceptance address' }, { status: 201 })).data.beneficiary;
    const form = new FormData(); form.set('documentType', 'VALID_ID'); form.set('file', new Blob([Buffer.from('%PDF-1.4\nSynthetic acceptance document\n%%EOF')], { type: 'application/pdf' }), 'synthetic-id.pdf');
    const document = (await request('barangay', `/beneficiaries/${beneficiary.beneficiaryId}/documents`, { method: 'POST', form, status: 201 })).data.document;
    const enrollment = (await post(submitter, `/programs/${program.programId}/enrollments`, { beneficiaryId: beneficiary.beneficiaryId }, { status: 201 })).data.enrollment;
    if (submitter === 'dswd') await post('dswd', `/enrollments/${enrollment.enrollmentId}/start-review`, {}, { status: 403, code: 'INDEPENDENT_REVIEW_REQUIRED' });
    const reviewer = submitter === 'dswd' ? 'dswd2' : 'dswd';
    await post(reviewer, `/enrollments/${enrollment.enrollmentId}/start-review`);
    await post(reviewer, `/enrollments/${enrollment.enrollmentId}/approve`, {}, { status: 409 });
    await post(reviewer, `/beneficiaries/${beneficiary.beneficiaryId}/documents/${document.documentId}/review`, { decision: 'ACCEPTED' });
    await post(reviewer, `/enrollments/${enrollment.enrollmentId}/approve`);
    return { beneficiary, enrollment };
  }
  const person = await approvedPerson('dswd');
  check('API document gating and independent enrollment review');
  async function draftEvent(deliveryMode = 'PHYSICAL_GOODS', verificationRequirement = 'QR') {
    const date = new Date(Date.now() + (++serial + 1) * 86400000).toISOString().slice(0, 10);
    const event = (await post('admin', '/distributions', { programId: program.programId, title: `Acceptance ${serial} ${deliveryMode}`, distributionDate: date, startTime: '08:00', endTime: '12:00', slotDurationMinutes: 30, location: 'Synthetic test hall', barangayId: barangays[0].barangayId, deliveryMode, verificationRequirement, ...(deliveryMode === 'PHYSICAL_GOODS' ? { packageName: 'Family food pack', packageUnit: 'pack', packageQuantity: 2 } : {}) }, { status: 201 })).data.distribution;
    await post('admin', `/distributions/${event.distributionId}/slots/generate`, { capacity: 20 }, { status: 201 });
    return event;
  }
  const event = await draftEvent();
  const eventPath = `/distributions/${event.distributionId}`;
  const allocationResults = await Promise.all(['admin', 'admin2'].map(role => post(role, `${eventPath}/allocations`, { enrollmentIds: [person.enrollment.enrollmentId] }, { key: randomUUID(), status: null })));
  assert.deepEqual(allocationResults.map(r => r.status).sort(), [201, 409], JSON.stringify(allocationResults));
  assert.equal(await prisma.distributionAllocation.count({ where: { distributionId: event.distributionId } }), 1);
  const scheduling = await Promise.all(['admin', 'barangay'].map(role => post(role, `${eventPath}/schedules/generate`, {}, { key: randomUUID(), status: null })));
  assert.ok(scheduling.some(r => r.status === 201), JSON.stringify(scheduling));
  assert.ok(scheduling.every(r => [200, 201, 409].includes(r.status)), JSON.stringify(scheduling));
  assert.equal(await prisma.schedule.count({ where: { distributionId: event.distributionId } }), 1);
  check('Two operators allocate and schedule concurrently without duplicate allocations or queue entries');

  const { notificationScheduleContextSelect, notificationRowFromSchedule, createNotificationRows } = await import('../src/modules/notifications/notification.service.js');
  const { processNotificationJob } = await import('../src/workers/notification.processor.js');
  const noticeScheduleId = (await prisma.schedule.findFirstOrThrow({ where: { distributionId: event.distributionId } })).scheduleId;
  const oldContact = person.beneficiary.contactNumber;
  await prisma.beneficiary.update({ where: { beneficiaryId: person.beneficiary.beneficiaryId }, data: { contactNumber: '+639171234567' } });
  const noticeContext = await prisma.schedule.findUniqueOrThrow({ where: { scheduleId: noticeScheduleId }, select: notificationScheduleContextSelect });
  const noticeNow = new Date();
  const noticeOptions = { notificationType: 'DISTRIBUTION_REMINDER', sendAt: noticeNow, now: noticeNow, initiatedById: staff.admin.user.userId };
  const queueNotice = async (context, options = noticeOptions) => (await createNotificationRows([notificationRowFromSchedule(context, options)])).notifications[0];
  let providerCalls = 0;
  const deliveryOptions = { database: prisma, publishLifecycle: async () => {}, provider: { send: async () => { providerCalls++; return { success: true, simulated: true, providerReference: `mock-only-${randomUUID()}` }; } } };
  const dispatch = notification => processNotificationJob({ data: { notificationId: notification.notificationId }, attemptsMade: 0, opts: { attempts: 1 } }, deliveryOptions);
  const cancelledNotice = await queueNotice(noticeContext);
  await prisma.schedule.update({ where: { scheduleId: noticeScheduleId }, data: { status: 'CANCELLED' } });
  assert.equal((await dispatch(cancelledNotice)).errorCode, 'NOTIFICATION_CONTEXT_CHANGED');
  assert.equal(providerCalls, 0);
  await prisma.schedule.update({ where: { scheduleId: noticeScheduleId }, data: { status: 'SCHEDULED' } });
  const refreshedNotice = await queueNotice(noticeContext);
  assert.notEqual(refreshedNotice.notificationId, cancelledNotice.notificationId);
  assert.equal((await dispatch(refreshedNotice)).outcome, 'SENT_SIMULATED');
  const changedContactNotice = await queueNotice(noticeContext, { ...noticeOptions, notificationType: 'SCHEDULE_UPDATED' });
  await prisma.beneficiary.update({ where: { beneficiaryId: person.beneficiary.beneficiaryId }, data: { contactNumber: '+639991239876' } });
  assert.equal((await dispatch(changedContactNotice)).errorCode, 'NOTIFICATION_CONTEXT_CHANGED');
  assert.equal(providerCalls, 1);
  const history = (await request('admin', `/notifications/${refreshedNotice.notificationId}`)).data.notification;
  assert.equal(history.recipientMasked, '********4567');
  assert.equal(Object.hasOwn(history, 'deliveryContextHash'), false);
  await prisma.beneficiary.update({ where: { beneficiaryId: person.beneficiary.beneficiaryId }, data: { contactNumber: oldContact ?? null } });
  check('Actual notification rows stop cancelled/changed-contact sends, permit a newly reviewed notice and preserve original recipient history');
  await request('admin', eventPath, { method: 'PATCH', body: { packageName: null, packageUnit: null, packageQuantity: null } });
  await post('admin', `${eventPath}/open`, {}, { status: 409, code: 'PHYSICAL_PACKAGE_REQUIRED' });
  await request('admin', eventPath, { method: 'PATCH', body: { packageName: 'Family food pack', packageUnit: 'pack', packageQuantity: 1.5 }, status: 400 });
  await request('barangay', eventPath, { method: 'PATCH', body: { packageQuantity: 3 }, status: 403 });
  await request('admin', eventPath, { method: 'PATCH', body: { packageName: 'Family food pack', packageUnit: 'pack', packageQuantity: 2 } });
  await post('admin', `${eventPath}/open`);
  await request('admin', eventPath, { method: 'PATCH', body: { packageQuantity: 3 }, status: 409 });
  check('Physical package is required before opening, validates whole units, and freezes with the event');
  await post('barangay', `${eventPath}/qr-tokens/generate`, {}, { status: 403 });
  const qr = (await post('dswd', `${eventPath}/qr-tokens/generate`, {}, { status: 201 })).data;
  assert.ok(qr.qrTokens?.length, JSON.stringify(qr));
  const issued = qr.qrTokens[0];
  await post('dswd', `${eventPath}/qr-tokens/${issued.qrTokenId}/revoke`, {}, { status: 403 });
  await post('dswd', `${eventPath}/qr-tokens/${issued.qrTokenId}/reissue`, {}, { status: 403 });
  await post('dswd', `${eventPath}/open`, {}, { status: 403 });
  await request('dswd', eventPath, { method: 'PATCH', body: { title: 'Unauthorized change' }, status: 403 });
  const issuerLog = await prisma.auditLog.findFirstOrThrow({ where: { recordId: issued.qrTokenId, action: 'QR_TOKEN_GENERATED' }, include: { user: true } });
  assert.equal(issuerLog.user.role, 'DSWD_STAFF');
  assert.equal(await prisma.claim.count({ where: { distributionId: event.distributionId } }), 0);
  check('DSWD issues QR cards with an issuer audit; facilitator issuance and DSWD event editing/replacement/revocation remain forbidden');
  const credential = qr.qrTokens[0].token;
  const claim = (await post('barangay', `${eventPath}/claims/verify-qr`, { token: credential }, { status: 201, key: randomUUID() })).data.claim;
  const releaseBody = { releasedQuantity: 2, evidenceType: 'OFFICIAL_RELEASE_LOG', evidenceReference: 'ACCEPTANCE-LOG-01', beneficiaryAcknowledged: true };
  for (const path of [eventPath, `${eventPath}/claims/${claim.claimId}`, `${eventPath}/schedules`, `${eventPath}/allocations`, `/beneficiaries/${person.beneficiary.beneficiaryId}`]) {
    await request('outsider', path, { status: 404 });
  }
  await post('outsider', `${eventPath}/claims/${claim.claimId}/release`, releaseBody, { status: 404, key: randomUUID() });
  await post('admin', `${eventPath}/claims/${claim.claimId}/release`, releaseBody, { status: 403, key: randomUUID() });
  await post('dswd', `${eventPath}/claims/${claim.claimId}/release`, releaseBody, { status: 403, key: randomUUID() });
  check('Wrong-barangay API reads/writes and unauthorized release are denied');
  for (const quantity of [undefined, 1, 3]) {
    await post('barangay', `${eventPath}/claims/${claim.claimId}/release`, { ...releaseBody, releasedQuantity: quantity }, { status: 409, code: 'PHYSICAL_RELEASE_QUANTITY_MISMATCH', key: randomUUID() });
  }
  assert.equal((await prisma.claim.findUniqueOrThrow({ where: { claimId: claim.claimId } })).claimStatus, 'VERIFIED');
  assert.equal(await prisma.auditLog.count({ where: { recordId: claim.claimId, action: 'PHYSICAL_ASSISTANCE_RELEASED' } }), 0);
  const releaseKeys = [randomUUID(), randomUUID()];
  const releaseBodies = [releaseBody, { ...releaseBody, evidenceReference: 'ACCEPTANCE-LOG-02' }];
  const releases = await Promise.all(['barangay', 'barangay2'].map((role, i) => post(role, `${eventPath}/claims/${claim.claimId}/release`, releaseBodies[i], { key: releaseKeys[i], status: null })));
  assert.deepEqual(releases.map(r => r.status).sort(), [201, 409], JSON.stringify(releases));
  const winningIndex = releases.findIndex(r => r.status === 201);
  const saved = await prisma.claim.findUniqueOrThrow({ where: { claimId: claim.claimId } });
  assert.equal(saved.releasedQuantity, 2);
  assert.equal(saved.releasedPackageName, 'Family food pack');
  assert.equal(saved.releasedPackageUnit, 'pack');
  assert.equal(saved.releaseEvidenceReference, releaseBodies[winningIndex].evidenceReference);
  assert.equal(await prisma.auditLog.count({ where: { recordId: claim.claimId, action: 'PHYSICAL_ASSISTANCE_RELEASED' } }), 1);
  const replay = await post(['barangay', 'barangay2'][winningIndex], `${eventPath}/claims/${claim.claimId}/release`, releaseBodies[winningIndex], { status: 201, key: releaseKeys[winningIndex] });
  assert.equal(replay.replayed, 'true');
  assert.deepEqual(replay.data, releases[winningIndex].data);
  await post(['barangay', 'barangay2'][winningIndex], `${eventPath}/claims/${claim.claimId}/release`, { ...releaseBody, evidenceReference: 'ALTERED' }, { status: 409, key: releaseKeys[winningIndex] });
  check('Concurrent physical release and saved-response replay preserve one actor, evidence and audit');
  await post('admin', `${eventPath}/close`, { notes: 'Must not close before receipt issuance.' }, { status: 409 });
  const receipts = await Promise.all(['barangay', 'dswd'].map(role => post(role, `${eventPath}/claims/${claim.claimId}/receipt`, {}, { status: null })));
  assert.ok(receipts.every(r => [200, 201].includes(r.status)), JSON.stringify(receipts));
  assert.equal(receipts[0].data.receipt.receiptId, receipts[1].data.receipt.receiptId);
  assert.equal(await prisma.claimReceipt.count({ where: { claimId: claim.claimId } }), 1);
  assert.equal(await prisma.auditLog.count({ where: { recordId: receipts[0].data.receipt.receiptId, action: 'CLAIM_RECEIPT_ISSUED' } }), 1);
  const reconciliation = (await request('admin', `${eventPath}/reconciliation`)).data.reconciliation;
  assert.equal(reconciliation.readyToClose, true);
  assert.deepEqual(receipts[0].data.receipt.snapshot.assistance.package, { name: 'Family food pack', unit: 'pack', quantity: 2 });
  assert.equal(reconciliation.physicalPackage.recordedQuantity, 2);
  assert.equal(reconciliation.physicalPackage.handoverCount, 1);
  assert.equal(reconciliation.physicalPackage.allocatedQuantity, 2);
  assert.equal(reconciliation.physicalPackage.quantityNotRecordedCount, 0);
  const physicalSummary = (await request('admin', `/reports${eventPath}/summary`)).data.report;
  assert.deepEqual(physicalSummary.data.physicalPackage, reconciliation.physicalPackage);
  check('Release quantities reject shortages and excess; saved package evidence agrees across receipt and report');
  assert.equal(reconciliation.physicalReleasedCount, 1);
  assert.equal(reconciliation.physicalReleasedAmount, '1500.00');
  const closures = await Promise.all(['admin', 'admin2'].map(role => post(role, `${eventPath}/close`, { notes: `Accepted by ${role} after receipt check.` }, { status: null })));
  assert.ok(closures.some(r => r.status === 200));
  assert.ok(closures.every(r => [200, 409].includes(r.status)), JSON.stringify(closures));
  assert.equal(await prisma.auditLog.count({ where: { recordId: event.distributionId, action: 'DISTRIBUTION_CLOSED' } }), 1);
  const originalClosure = await prisma.auditLog.findFirstOrThrow({ where: { recordId: event.distributionId, action: 'DISTRIBUTION_CLOSED' } });
  await post('admin', `${eventPath}/close`, { notes: 'Retry must not replace original evidence.' });
  assert.deepEqual((await prisma.auditLog.findUniqueOrThrow({ where: { auditId: originalClosure.auditId } })).details, originalClosure.details);
  await post('barangay', `${eventPath}/claims/verify-qr`, { token: credential }, { status: 409, key: randomUUID() });
  await post('barangay', `${eventPath}/claims/${claim.claimId}/release`, releaseBody, { status: 409, key: randomUUID() });
  await post('admin', `${eventPath}/schedules/generate`, {}, { status: 409, key: randomUUID() });
  check('Concurrent receipt/closure, reconciliation and closed-event restrictions');

  async function prepareEvent(mode, requirement, target = person) {
    const event = await draftEvent(mode, requirement);
    const path = `/distributions/${event.distributionId}`;
    await post('admin', `${path}/allocations`, { enrollmentIds: [target.enrollment.enrollmentId] }, { status: 201, key: randomUUID() });
    await post('admin', `${path}/schedules/generate`, {}, { status: 201, key: randomUUID() });
    await post('admin', `${path}/open`);
    return event;
  }
  async function enrollFace(target) {
    const consent = (await post('barangay', `/beneficiaries/${target.beneficiary.beneficiaryId}/biometric-consents`, { consentVersion: 'acceptance-v1', consentGiven: true, retentionUntil: new Date(Date.now() + 86400000 * 60).toISOString() }, { status: 201 })).data.consent;
    const capture = syntheticCapture(target.beneficiary.beneficiaryId);
    const form = new FormData(); form.set('consentId', consent.consentId); form.set('faceCapture', new Blob([capture], { type: 'image/png' }), 'simulated-capture.png');
    await request('barangay', `/beneficiaries/${target.beneficiary.beneficiaryId}/biometrics/enroll`, { method: 'POST', form, status: 201 });
    return { consent, capture };
  }
  async function verifyFace(target, event, capture, status = 201, code) {
    const form = new FormData(); form.set('beneficiaryId', target.beneficiary.beneficiaryId); form.set('faceCapture', new Blob([capture], { type: 'image/png' }), 'simulated-capture.png');
    return request('dswd', `/distributions/${event.distributionId}/claims/verify-biometric`, { method: 'POST', form, key: randomUUID(), status, code });
  }
  for (const mode of ['PHYSICAL_GOODS', 'SIMULATED_WALLET']) {
    const contestedEvent = await prepareEvent(mode, 'QR');
    const contestedPath = `/distributions/${contestedEvent.distributionId}`;
    const completionRole = mode === 'PHYSICAL_GOODS' ? 'barangay' : 'dswd';
    const completionAction = mode === 'PHYSICAL_GOODS' ? 'release' : 'credit';
    const completionBody = mode === 'PHYSICAL_GOODS' ? releaseBody : {};
    const contestedQr = (await post('admin', `${contestedPath}/qr-tokens/generate`, {}, { status: 201 })).data.qrTokens[0].token;
    const contestedClaim = (await post('barangay', `${contestedPath}/claims/verify-qr`, { token: contestedQr }, { key: randomUUID(), status: 201 })).data.claim;
    // A real row lock pauses the release after its checks; no controller or database method is mocked.
    const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    let releaseInFlight;
    let dispute;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT claim_id FROM claims WHERE claim_id = $1 FOR NO KEY UPDATE', [contestedClaim.claimId]);
      releaseInFlight = post(completionRole, `${contestedPath}/claims/${contestedClaim.claimId}/${completionAction}`, completionBody, { key: randomUUID(), status: null });
      const deadline = Date.now() + 4000;
      let waiting = false;
      while (Date.now() < deadline) {
        const rows = await prisma.$queryRaw`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'UPDATE%claims%'`;
        if (rows.length) { waiting = true; break; }
        await new Promise(done => setTimeout(done, 20));
      }
      assert.equal(waiting, true, 'Release must be paused on its write before the competing dispute is filed.');
      dispute = (await post('dswd', `${contestedPath}/claims/${contestedClaim.claimId}/disputes`, { reasonCode: 'SUSPECTED_IDENTITY_MISUSE', statement: 'Synthetic competing identity concern before physical handover.', beneficiaryPresent: true }, { status: 201 })).data.dispute;
    } finally {
      await blocker.query('ROLLBACK');
      await blocker.end();
    }
    const contestedRelease = await releaseInFlight;
    assert.equal(contestedRelease.status, 409, 'A dispute committed while release was paused must prevent that stale release.');
    assert.equal((await prisma.claim.findUniqueOrThrow({ where: { claimId: contestedClaim.claimId } })).claimStatus, 'VERIFIED');
    assert.equal(await prisma.auditLog.count({ where: { recordId: contestedClaim.claimId, action: 'PHYSICAL_ASSISTANCE_RELEASED' } }), 0);
    assert.equal(await prisma.transaction.count({ where: { claimId: contestedClaim.claimId } }), 0);
    await post(completionRole, `${contestedPath}/claims/${contestedClaim.claimId}/${completionAction}`, completionBody, { key: randomUUID(), status: 409, code: 'ACTIVE_CLAIM_DISPUTE' });
    await post('dswd', `${contestedPath}/claim-disputes/${dispute.disputeId}/review`, { action: 'START_REVIEW', expectedUpdatedAt: dispute.updatedAt }, { status: 409, code: 'INDEPENDENT_REVIEW_REQUIRED' });
    const review = (await post('admin', `${contestedPath}/claim-disputes/${dispute.disputeId}/review`, { action: 'START_REVIEW', expectedUpdatedAt: dispute.updatedAt })).data.dispute;
    const staleClaimVersion = review.claim.updatedAt;
    await post('barangay', `${contestedPath}/claims/verify-qr`, { token: contestedQr }, { status: 409, key: randomUUID() });
    await post('admin', `${contestedPath}/claim-disputes/${dispute.disputeId}/review`, { action: 'CONFIRM_CLAIM', expectedUpdatedAt: review.updatedAt, expectedClaimUpdatedAt: staleClaimVersion, reviewNotes: 'Synthetic independent review must refresh changed evidence.' }, { status: 409, code: 'CLAIM_DISPUTE_CONCURRENT_CHANGE' });
    check(`${mode}: a dispute committed during completion blocks the stale write; self-review and stale claim decisions are rejected`);
  }

  const identity = await enrollFace(person);
  const combinedEvent = await prepareEvent('SIMULATED_WALLET', 'QR_AND_BIOMETRIC');
  const combinedPath = `/distributions/${combinedEvent.distributionId}`;
  const combinedTokens = (await post('admin', `${combinedPath}/qr-tokens/generate`, {}, { status: 201 })).data.qrTokens;
  const pending = (await post('dswd', `${combinedPath}/claims/verify-qr`, { token: combinedTokens[0].token }, { status: 201, key: randomUUID() })).data.claim;
  assert.equal(pending.claimStatus, 'PENDING');
  await post('dswd', `${combinedPath}/claims/${pending.claimId}/credit`, {}, { status: 409, key: randomUUID() });
  await post('barangay', `${combinedPath}/claims/${pending.claimId}/receipt`, {}, { status: 409 });
  await verifyFace(person, combinedEvent, syntheticCapture('wrong-person'), 422, 'BIOMETRIC_NO_MATCH');
  const matched = await verifyFace(person, combinedEvent, identity.capture);
  assert.equal(matched.data.claim.claimStatus, 'VERIFIED');
  const creditKey = randomUUID();
  const credits = await Promise.all(['dswd', 'dswd2'].map(role => post(role, `${combinedPath}/claims/${pending.claimId}/credit`, {}, { key: role === 'dswd' ? creditKey : randomUUID(), status: null })));
  assert.deepEqual(credits.map(r => r.status).sort(), [201, 409], JSON.stringify(credits));
  assert.equal(await prisma.transaction.count({ where: { claimId: pending.claimId, transactionType: 'BENEFIT_CREDIT' } }), 1);
  await post('dswd', `${combinedPath}/claims/${pending.claimId}/receipt`, {}, { status: 201 });
  const walletReconciliation = (await request('admin', `${combinedPath}/reconciliation`)).data.reconciliation;
  assert.equal(walletReconciliation.netCreditedAmount, '1500.00');
  assert.equal(walletReconciliation.readyToClose, true);
  await post('admin', `${combinedPath}/close`, { notes: 'Simulated credit and receipt reconciled.' });
  check('QR plus simulated face gating, mismatches and concurrent wallet credit reconcile once');

  const signaturePerson = await approvedPerson();
  const signatureIdentity = await enrollFace(signaturePerson);
  const signatureEvent = await prepareEvent('PHYSICAL_GOODS', 'BIOMETRIC_AND_SIGNATURE', signaturePerson);
  const signatureClaim = (await verifyFace(signaturePerson, signatureEvent, signatureIdentity.capture)).data.claim;
  assert.equal(signatureClaim.claimStatus, 'PENDING');
  await post('barangay', `/distributions/${signatureEvent.distributionId}/claims/${signatureClaim.claimId}/release`, releaseBody, { status: 409, key: randomUUID() });
  check('Face-only partial claim cannot release when signature is required');

  const consentPerson = await approvedPerson();
  const consentIdentity = await enrollFace(consentPerson);
  const consentEvent = await prepareEvent('PHYSICAL_GOODS', 'BIOMETRIC', consentPerson);
  await prisma.biometricConsent.update({ where: { consentId: consentIdentity.consent.consentId }, data: { retentionUntil: new Date(Date.now() - 1000) } });
  await verifyFace(consentPerson, consentEvent, consentIdentity.capture, 409, 'BIOMETRIC_CONSENT_INVALID');
  await prisma.biometricConsent.update({ where: { consentId: consentIdentity.consent.consentId }, data: { retentionUntil: new Date(Date.now() + 86400000) } });
  await post('barangay', `/beneficiaries/${consentPerson.beneficiary.beneficiaryId}/biometric-consents/${consentIdentity.consent.consentId}/revoke`);
  await verifyFace(consentPerson, consentEvent, consentIdentity.capture, 409, 'BIOMETRIC_CONSENT_INVALID');
  assert.equal(await prisma.claim.count({ where: { distributionId: consentEvent.distributionId } }), 0);
  check('Expired and revoked consent reject verification without creating a claim');

  const voidedEvent = await prepareEvent('PHYSICAL_GOODS', 'QR');
  const voidedPath = `/distributions/${voidedEvent.distributionId}`;
  const voidedQr = (await post('admin', `${voidedPath}/qr-tokens/generate`, {}, { status: 201 })).data.qrTokens[0].token;
  const voidedClaim = (await post('barangay', `${voidedPath}/claims/verify-qr`, { token: voidedQr }, { status: 201, key: randomUUID() })).data.claim;
  await post('barangay', `${voidedPath}/claims/${voidedClaim.claimId}/release`, releaseBody, { status: 201, key: randomUUID() });
  const originalReceipt = (await post('barangay', `${voidedPath}/claims/${voidedClaim.claimId}/receipt`, {}, { status: 201 })).data.receipt;
  const concern = (await post('barangay', `${voidedPath}/claims/${voidedClaim.claimId}/disputes`, { reasonCode: 'RECEIPT_OR_RECORD_ERROR', statement: 'Synthetic handover discrepancy for independent review.', beneficiaryPresent: true }, { status: 201 })).data.dispute;
  const review = (await post('dswd', `${voidedPath}/claim-disputes/${concern.disputeId}/review`, { action: 'START_REVIEW', expectedUpdatedAt: concern.updatedAt })).data.dispute;
  await post('dswd', `${voidedPath}/claim-disputes/${concern.disputeId}/review`, { action: 'COMPLETE_REMEDIATION', expectedUpdatedAt: review.updatedAt, expectedClaimUpdatedAt: review.claim.updatedAt, reviewNotes: 'Synthetic discrepancy documented; the original handover is retained, with no stock return inferred.' });
  const voidedReconciliation = (await request('admin', `${voidedPath}/reconciliation`)).data.reconciliation;
  assert.equal(voidedReconciliation.claimCounts.VOIDED, 1);
  assert.equal(voidedReconciliation.physicalReleasedCount, 0);
  assert.equal(voidedReconciliation.physicalPackage.handoverCount, 1);
  assert.equal(voidedReconciliation.physicalPackage.recordedQuantity, 2);
  assert.equal(voidedReconciliation.physicalPackage.voidedClaimQuantity, 2);
  const voidedSummary = (await request('admin', `/reports${voidedPath}/summary`)).data.report;
  assert.deepEqual(voidedSummary.data.physicalPackage, voidedReconciliation.physicalPackage);
  const retainedReceipt = await prisma.claimReceipt.findUniqueOrThrow({ where: { claimId: voidedClaim.claimId } });
  assert.deepEqual(retainedReceipt.snapshot, originalReceipt.snapshot);
  assert.equal(retainedReceipt.evidenceHash, originalReceipt.evidenceHash);
  check('Independent remediation preserves voided handover counts, quantities and issued receipt evidence');

  const copyEvent = await prepareEvent('PHYSICAL_GOODS', 'QR');
  const copyPath = `/distributions/${copyEvent.distributionId}`;
  const issuances = await Promise.all(['admin', 'dswd'].map(role => post(role, `${copyPath}/qr-tokens/generate`, {}, { status: null })));
  assert.deepEqual(issuances.map(result => result.status).sort(), [201, 409]);
  const copyQr = issuances.find(result => result.status === 201).data.qrTokens[0];
  assert.equal(await prisma.qrToken.count({ where: { distributionId: copyEvent.distributionId } }), 1);
  const listed = (await request('dswd', `${copyPath}/qr-tokens`)).data;
  assert.equal(JSON.stringify(listed).includes(copyQr.token), false);
  assert.equal(JSON.stringify(listed).includes('tokenHash'), false);
  await post(null, `${copyPath}/claims/verify-qr`, { token: copyQr.token }, { status: 401, key: randomUUID() });
  for (const token of [`${copyQr.token}altered`, credential]) {
    await post('dswd', `${copyPath}/claims/verify-qr`, { token }, { status: 404, code: 'INVALID_QR_TOKEN', key: randomUUID() });
  }
  await post('dswd', `${copyPath}/claims/preview-qr`, { token: copyQr.token });
  assert.equal(await prisma.claim.count({ where: { distributionId: copyEvent.distributionId } }), 0);
  check('Concurrent Admin/DSWD issuance creates one QR; anonymous, altered and wrong-event credentials cannot create claims, and preview changes no claim');
  const scans = await Promise.all(['barangay', 'dswd'].map(role => post(role, `${copyPath}/claims/verify-qr`, { token: copyQr.token }, { key: randomUUID(), status: null })));
  assert.deepEqual(scans.map(result => result.status).sort(), [201, 409]);
  assert.equal(await prisma.claim.count({ where: { distributionId: copyEvent.distributionId } }), 1);
  const copyClaim = await prisma.claim.findFirstOrThrow({ where: { distributionId: copyEvent.distributionId } });
  assert.equal(copyClaim.isDuplicateFlag, true);
  assert.equal(copyClaim.releasedAt, null);
  await post('barangay', `${copyPath}/claims/${copyClaim.claimId}/release`, releaseBody, { status: 409, code: 'CLAIM_DUPLICATE_REVIEW_REQUIRED', key: randomUUID() });
  assert.equal(await prisma.claimReceipt.count({ where: { claimId: copyClaim.claimId } }), 0);
  check('Simultaneous copied-QR scans create one claim and flag a duplicate; no handover or receipt is recorded and release awaits independent review');

  return { staff, barangays, program, request, post, check, draftEvent, approvedPerson, prepareEvent, enrollFace, verifyFace, signaturePerson, signatureEvent, signatureClaim, voidedEvent, completedEvents: [event, combinedEvent] };
}
