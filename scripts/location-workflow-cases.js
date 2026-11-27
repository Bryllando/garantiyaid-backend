import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startBeneficiaryImport, claimBeneficiaryImport, processBeneficiaryImportBatch, getBeneficiaryImportResults } from '../src/modules/beneficiaries/beneficiaryImportJob.service.js';

export async function runLocationCases({ prisma, barangays, staff, request, post, check }) {
  const [north, south] = barangays;
  for (const barangay of barangays) Object.assign(barangay, (await request('admin', `/barangays/${barangay.barangayId}`, { method: 'PATCH', body: { serviceAreas: ['Sitio Riverside', `Purok ${barangay === north ? 'North' : 'South'}`] } })).data.barangay);
  const otherCity = (await post('admin', '/barangays', { barangayName: north.barangayName, city: 'Other Test City', province: 'Test Province', serviceAreas: ['Sitio Riverside'] }, { status: 201 })).data.barangay;
  await request('barangay', `/barangays/${north.barangayId}`, { method: 'PATCH', body: { serviceAreas: ['Self assigned'] }, status: 403 });
  assert.deepEqual((await request('barangay', '/barangays')).data.barangays.map(b => b.barangayId), [north.barangayId]);
  assert.equal((await request('dswd', '/barangays')).data.barangays.length, 3);
  const facilitatorId = staff.barangay.user.userId;
  await prisma.user.update({ where: { userId: facilitatorId }, data: { barangayId: null } });
  await request('barangay', '/barangays', { status: 403, code: 'BARANGAY_ASSIGNMENT_REQUIRED' });
  await prisma.user.update({ where: { userId: facilitatorId }, data: { barangayId: north.barangayId } });
  await request('admin', `/barangays/${north.barangayId}`, { method: 'PATCH', body: { serviceAreas: ['Sitio Riverside', ' sitio riverside '] }, status: 400 });
  check('Confirmed areas belong to their parent Barangay; identical names remain distinct and only Admin edits the registry');

  async function activeProgram(code) {
    const p = (await post('dswd', '/programs', {
      programName: `Location ${code}`, programCode: code, programType: 'CASH_ASSISTANCE', grantAmount: 100, budgetAmount: 100000, requiredDocumentTypes: ['VALID_ID'],
      criteria: [{ criterionName: 'Adult applicant', fieldName: 'AGE', operator: 'GREATER_THAN_OR_EQUAL', expectedValue: 18 }],
    }, { status: 201 })).data.program;
    await post('dswd', `/programs/${p.programId}/activate`);
    return p;
  }
  const program = await activeProgram('LOCATION-1');
  const otherProgram = await activeProgram('LOCATION-2');
  async function enroll(person, targetProgram, role = 'barangay', correction = false) {
    const form = new FormData(); form.set('documentType', 'VALID_ID'); form.set('file', new Blob(['%PDF-1.4\nSynthetic location document\n%%EOF'], { type: 'application/pdf' }), 'location-id.pdf');
    const doc = (await request(role, `/beneficiaries/${person.beneficiaryId}/documents`, { method: 'POST', form, status: 201 })).data.document;
    const enrollment = (await post(role, `/programs/${targetProgram.programId}/enrollments`, { beneficiaryId: person.beneficiaryId }, { status: 201 })).data.enrollment;
    await post(role, `/programs/${targetProgram.programId}/enrollments`, { beneficiaryId: person.beneficiaryId }, { status: 409 });
    await post('dswd', `/enrollments/${enrollment.enrollmentId}/start-review`);
    if (targetProgram.programId === program.programId) await post('dswd', `/enrollments/${enrollment.enrollmentId}/approve`, {}, { status: 409 });
    if (correction) {
      await post('dswd', `/enrollments/${enrollment.enrollmentId}/request-correction`, { reason: 'Correct the house address against the submitted record.' });
      assert.equal((await request(role, `/enrollments/${enrollment.enrollmentId}`)).data.enrollment.status, 'NEEDS_CORRECTION');
      await request(role, `/beneficiaries/${person.beneficiaryId}`, { method: 'PATCH', body: { address: 'Corrected synthetic house address' } });
      await post(role, `/enrollments/${enrollment.enrollmentId}/resubmit`);
      await post('dswd', `/enrollments/${enrollment.enrollmentId}/start-review`);
    }
    await post('dswd', `/beneficiaries/${person.beneficiaryId}/documents/${doc.documentId}/review`, { decision: 'ACCEPTED' });
    return (await post('dswd', `/enrollments/${enrollment.enrollmentId}/approve`)).data.enrollment;
  }
  const create = async (role, firstName, sitioPurok) => (await post(role, '/beneficiaries', { firstName, lastName: 'Location', birthDate: '1990-01-12', sex: 'FEMALE', address: 'Synthetic house address', ...(sitioPurok ? { sitioPurok } : {}) }, { status: 201 })).data.beneficiary;
  const person = await create('barangay', 'Riverside', 'Sitio Riverside');
  const missing = await create('barangay', 'MissingArea');
  const outside = await create('outsider', 'Outside', 'Sitio Riverside');
  const enrollment = await enroll(person, program, 'barangay', true);
  const missingEnrollment = await enroll(missing, program);
  const outsideEnrollment = await enroll(outside, program, 'outsider');
  const secondEnrollment = await enroll(person, otherProgram);
  for (const role of ['admin', 'dswd', 'barangay']) {
    const rows = (await request(role, `/enrollments?beneficiaryId=${person.beneficiaryId}`)).data.enrollments;
    assert.equal(rows.length, 2); assert.ok(rows.every(row => row.beneficiaryId === person.beneficiaryId && row.status === 'APPROVED'));
  }
  assert.equal((await request('outsider', `/enrollments?beneficiaryId=${person.beneficiaryId}`)).data.enrollments.length, 0);
  await request('dswd', `/beneficiaries/${person.beneficiaryId}`, { method: 'PATCH', body: { sitioPurok: 'Not permitted' }, status: 403 });
  await request('barangay', `/beneficiaries/${outside.beneficiaryId}`, { status: 404 });
  check('Enrollment submission, document gate, correction/resubmission, approval, duplicate protection and exact beneficiary lookup retain role scope');

  let day = 90;
  const createEvent = async (title, targetProgram = program, barangay = north) => (await post('admin', '/distributions', { title, programId: targetProgram.programId, barangayId: barangay.barangayId, distributionDate: new Date(Date.now() + ++day * 86400000).toISOString().slice(0, 10), startTime: '08:00', endTime: '10:00', slotDurationMinutes: 30, location: 'Synthetic location hall', deliveryMode: 'PHYSICAL_GOODS', verificationRequirement: 'QR', packageName: 'Synthetic pack', packageUnit: 'pack', packageQuantity: 1 }, { status: 201 })).data.distribution;
  const event = await createEvent('Original location event');
  const path = `/distributions/${event.distributionId}`;
  const session = { label: 'Riverside session', date: event.distributionDate.slice(0, 10), startTime: '08:00', endTime: '10:00', location: 'Synthetic location hall', capacity: 10, serviceAreas: ['Purok South'] };
  await post('admin', `${path}/slots/generate`, { sessions: [session] }, { status: 409, code: 'SERVICE_AREA_REVIEW_REQUIRED' });
  await post('admin', `${path}/slots/generate`, { sessions: [{ ...session, serviceAreas: ['Sitio Riverside'] }] }, { status: 201 });
  await post('admin', `${path}/allocations`, { enrollmentIds: [outsideEnrollment.enrollmentId] }, { status: 409, key: randomUUID() });
  await post('admin', `${path}/allocations`, { enrollmentIds: [missingEnrollment.enrollmentId] }, { status: 409, key: randomUUID() });
  await post('admin', `${path}/allocations`, { enrollmentIds: [enrollment.enrollmentId] }, { status: 201, key: randomUUID() });
  await post('admin', `${path}/schedules/generate`, {}, { status: 201, key: randomUUID() });
  const appointment = (await request('admin', `${path}/schedules`)).data.schedules[0];
  assert.equal(appointment.beneficiaryId, person.beneficiaryId);
  assert.ok(appointment.slot.serviceAreas.includes('Sitio Riverside'));
  await post('admin', `${path}/open`);
  const credential = (await post('admin', `${path}/qr-tokens/generate`, {}, { status: 201 })).data.qrTokens[0].token;
  const claim = (await post('barangay', `${path}/claims/verify-qr`, { token: credential }, { status: 201, key: randomUUID() })).data.claim;
  await post('barangay', `${path}/claims/${claim.claimId}/release`, { releasedQuantity: 1, evidenceType: 'OFFICIAL_RELEASE_LOG', evidenceReference: 'SYNTHETIC-LOCATION-LOG', beneficiaryAcknowledged: true }, { status: 201, key: randomUUID() });
  const receipt = (await post('barangay', `${path}/claims/${claim.claimId}/receipt`, {}, { status: 201 })).data.receipt;
  check('A matching area enrollment is allocated, scheduled, QR verified, released and receipted; missing and wrong-Barangay areas cannot use it');

  const nextEvent = await createEvent('New event with separate records');
  const nextPath = `/distributions/${nextEvent.distributionId}`;
  await post('admin', `${nextPath}/slots/generate`, { capacity: 10 }, { status: 201 });
  for (const resource of ['allocations', 'schedules', 'claims']) assert.equal((await request('admin', `${nextPath}/${resource}`)).data[resource].length, 0);
  await post('admin', `${nextPath}/allocations`, { enrollmentIds: [enrollment.enrollmentId, missingEnrollment.enrollmentId] }, { status: 201, key: randomUUID() });
  await post('admin', `${nextPath}/schedules/generate`, {}, { status: 201, key: randomUUID() });
  const nextAppointments = (await request('barangay', `${nextPath}/schedules`)).data.schedules;
  assert.equal(nextAppointments.length, 2); assert.ok(nextAppointments.every(row => row.distributionId === nextEvent.distributionId));
  assert.equal((await request('barangay', `${nextPath}/claims`)).data.claims.length, 0);
  const preserved = await prisma.claimReceipt.findUniqueOrThrow({ where: { receiptId: receipt.receiptId }, include: { claim: true } });
  assert.equal(preserved.claim.distributionId, event.distributionId); assert.deepEqual(preserved.snapshot, receipt.snapshot);
  const unrelatedEvent = await createEvent('Other program event', otherProgram);
  const outsideEvent = await createEvent('Other Barangay event', program, south);
  await request('outsider', nextPath, { status: 404 });
  for (const role of ['admin', 'dswd', 'barangay']) {
    const choices = (await request(role, `/distributions?programId=${program.programId}&barangayId=${north.barangayId}`)).data.distributions;
    assert.deepEqual(new Set(choices.map(row => row.distributionId)), new Set([event.distributionId, nextEvent.distributionId]));
  }
  check('Approved enrollment is reusable in another event; Whole Barangay accepts missing Sitio and the prior receipt stays with its original claim/event');

  const rows = [
    { sourceRow: 2, firstName: 'ImportedKnown', lastName: 'Location', birthDate: '1990-01-12', sex: 'FEMALE', address: 'Synthetic import address', barangayId: north.barangayId, city: north.city, sitioPurok: 'Sitio Riverside' },
    { sourceRow: 3, firstName: 'ImportedLegacy', lastName: 'Location', birthDate: '1990-01-12', sex: 'FEMALE', address: 'Synthetic import address', barangayId: otherCity.barangayId, city: otherCity.city, sitioPurok: 'Unconfirmed legacy text' },
  ];
  const review = (await post('admin', '/beneficiaries/import/preview', { rows })).data;
  assert.equal(review.invalidCount, 0); assert.equal(review.rows[1].warnings.length, 1);
  const badCity = (await post('admin', '/beneficiaries/import/preview', { rows: [{ ...rows[0], city: south.city + ' wrong' }] })).data;
  assert.equal(badCity.invalidCount, 1);
  const actor = await prisma.user.findUniqueOrThrow({ where: { userId: staff.admin.user.userId } });
  const job = await startBeneficiaryImport({ staffUser: actor, auth: { userId: actor.userId }, get: () => review.approvalId, validatedBody: { rows, approvalId: review.approvalId, confirmed: true }, ip: '127.0.0.1' });
  await processBeneficiaryImportBatch(await claimBeneficiaryImport());
  const imported = await getBeneficiaryImportResults(actor, job.importId);
  assert.equal(imported.createdCount, 2);
  const retained = await prisma.beneficiary.findUniqueOrThrow({ where: { beneficiaryId: imported.beneficiaries[1].beneficiary.beneficiaryId } });
  assert.equal(retained.sitioPurok, 'Unconfirmed legacy text'); assert.equal(retained.barangayId, otherCity.barangayId);
  assert.equal((await post('admin', '/beneficiaries/import/preview', { rows })).data.invalidCount, 2);
  check('Real import preview and isolated batch worker preserve parent IDs, flag unconfirmed text, reject a mismatched City and protect existing beneficiaries');
  return { program, otherProgram, person, missing, enrollment, secondEnrollment, event, nextEvent, unrelatedEvent, outsideEvent, receipt, createEvent, locations: [north, south, otherCity] };
}
