import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { resolve } from 'node:path';
import prisma from '../src/lib/prisma.js';
import { env } from '../src/config/env.js';
import app from '../src/app.js';
import { issueAccessToken } from '../src/modules/auth/auth.service.js';
import { buildDistributionSlotRows } from '../src/modules/distributions/distributionSlot.service.js';
import { assertNoDistributionOverlap, assertDistributionConfigurationValid } from '../src/modules/distributions/distribution.service.js';

const args = process.argv.slice(2);
const run = args.find((arg) => arg.startsWith('--run='))?.slice(6) || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
const marker = `TEST-CLAIM-${run}`;
const output = resolve('recovery', `claim-demo-${run}`);
const credentialPath = resolve(output, 'credentials.json');
const fixtureNote = 'TEST ONLY — synthetic claim rehearsal. Not an identity approval or authorization for real government assistance.';
const uuid = (name) => { const hex = createHash('sha256').update(`${marker}:${name}`).digest('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`; };
let server, authSession;

try {
  assert.ok(args.includes('--apply') && args.includes('--local-demo'), 'Use --apply --local-demo only against an isolated local development/demo environment. No messages are sent.');
  assert.match(run, /^[a-zA-Z0-9-]{1,14}$/, 'Use a short letters/numbers run label.');
  assert.notEqual(env.nodeEnv, 'production', 'Demo fixtures refuse production.');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.databaseUrl).hostname), 'Demo fixtures require local PostgreSQL.');
  const admin = await prisma.user.findFirst({ where: { role: 'SYSTEM_ADMIN', isActive: true }, orderBy: { createdAt: 'asc' } });
  const facilitator = await prisma.user.findFirst({ where: { role: 'BARANGAY_FACILITATOR', isActive: true, barangayId: { not: null }, barangay: { isActive: true } }, orderBy: { createdAt: 'asc' } });
  const reviewer = await prisma.user.findFirst({ where: { role: 'DSWD_STAFF', isActive: true }, orderBy: { createdAt: 'asc' } });
  assert.ok(admin && facilitator && reviewer, 'An active Admin, assigned Barangay Facilitator and independent DSWD reviewer are required. No staff accounts are created.');
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const date = new Date(`${values.year}-${values.month}-${values.day}T00:00:00Z`);
  const start = Math.max(0, Math.floor((Number(values.hour) * 60 + Number(values.minute)) / 10) * 10 - 10);
  const duration = Math.min(60, Math.floor((1439 - start) / 4));
  assert.ok(duration >= 5, 'Not enough time remains today for four non-overlapping demo sessions. Prepare a new run on another day.');
  const time = (minutes) => new Date(`1970-01-01T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00Z`);
  const scenarios = [['QR', 'Qr'], ['BIOMETRIC', 'Face'], ['QR_AND_BIOMETRIC', 'Face'], ['MANUAL', 'Manual']];
  await prisma.$transaction(async (tx) => {
    const existing = await tx.program.findUnique({ where: { programCode: marker } });
    if (existing) assert.equal(existing.description, fixtureNote, 'Refusing to modify an unrelated program.');
    const program = await tx.program.upsert({ where: { programCode: marker }, update: {}, create: {
      programId: uuid('program'), programCode: marker, programName: `TEST ONLY — Claim rehearsal ${run}`, programType: 'CLAIM_DEMO', description: fixtureNote,
      grantAmount: '1.00', budgetAmount: '4.00', status: 'ACTIVE', createdById: admin.userId, requiredDocumentTypes: [],
    } });
    for (const person of ['Qr', 'Face', 'Manual']) {
      await tx.beneficiary.upsert({ where: { beneficiaryId: uuid(person) }, update: {}, create: {
        beneficiaryId: uuid(person), firstName: 'DEMO', middleName: person, lastName: 'Participant', birthDate: new Date('1990-01-01'), sex: 'OTHER',
        barangayId: facilitator.barangayId, address: fixtureNote, contactNumber: null, email: null, status: 'ACTIVE',
      } });
      await tx.enrollment.upsert({ where: { beneficiaryId_programId: { beneficiaryId: uuid(person), programId: program.programId } }, update: {}, create: {
        beneficiaryId: uuid(person), programId: program.programId, status: 'APPROVED', submittedById: facilitator.userId, reviewedById: reviewer.userId,
        reviewedAt: new Date(), reviewNotes: fixtureNote, eligibilitySnapshot: { demoOnly: true, source: marker },
      } });
    }
    for (const [index, [method, person]] of scenarios.entries()) {
      const distributionId = uuid(method === 'QR' ? 'event-qr' : method);
      if (await tx.distribution.findUnique({ where: { distributionId } })) continue;
      const candidate = {
        distributionId, programId: program.programId, createdById: admin.userId, barangayId: facilitator.barangayId,
        title: `TEST ONLY — ${method} claim ${run}`, status: 'OPEN', distributionDate: date, startTime: time(start + index * duration), endTime: time(start + (index + 1) * duration), slotDurationMinutes: duration,
        location: 'TEST ONLY — supervised demo desk', deliveryMode: 'PHYSICAL_GOODS', packageName: 'TEST ONLY demo pack', packageUnit: 'pack', packageQuantity: 1,
        verificationRequirement: method, manualVerificationBasis: method === 'MANUAL' ? 'TEST ONLY — authorized reviewer checks the consenting demo participant against the synthetic appointment and records the supervised identity-review exercise. No government ID policy is asserted.' : null,
      };
      assertDistributionConfigurationValid(candidate);
      await assertNoDistributionOverlap(candidate, tx);
      const event = await tx.distribution.create({ data: candidate });
      const [slotData] = buildDistributionSlotRows(event, 1);
      const slot = await tx.distributionSlot.create({ data: slotData });
      const enrollment = await tx.enrollment.findUniqueOrThrow({ where: { beneficiaryId_programId: { beneficiaryId: uuid(person), programId: program.programId } } });
      await tx.distributionAllocation.create({ data: { distributionId, beneficiaryId: uuid(person), enrollmentId: enrollment.enrollmentId, amount: '1.00', allocationStatus: 'ALLOCATED', allocatedById: admin.userId, allocatedAt: new Date() } });
      await tx.schedule.create({ data: { distributionId, beneficiaryId: uuid(person), slotId: slot.slotId, queueNumber: 1, status: 'SCHEDULED' } });
      await tx.auditLog.create({ data: { userId: admin.userId, action: 'LOCAL_CLAIM_DEMO_PREPARED', entityAffected: 'DISTRIBUTION', recordId: distributionId, details: { source: marker, demoOnly: true, fixtureNote, seededReview: true, noBiometricConsentOrMatchFabricated: true } } });
    }
  }, { timeout: 30000 });
  await mkdir(output, { recursive: true });
  const saved = await readFile(credentialPath, 'utf8').then(JSON.parse).catch((err) => { if (err.code === 'ENOENT') return { cards: [] }; throw err; });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  authSession = await issueAccessToken(admin, { ipAddress: '127.0.0.1' });
  const events = await prisma.distribution.findMany({ where: { program: { programCode: marker } }, orderBy: { title: 'asc' } });
  for (const event of events.filter((item) => ['QR', 'QR_AND_BIOMETRIC'].includes(item.verificationRequirement))) {
    if (await prisma.qrToken.count({ where: { distributionId: event.distributionId } })) continue;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/distributions/${event.distributionId}/qr-tokens/generate`, {
      method: 'POST', headers: { authorization: `Bearer ${authSession.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    const result = await response.json();
    assert.equal(response.status, 201, `QR issuance failed: ${result.error?.code || 'unknown error'}`);
    saved.cards.push({ distribution: { ...event, distributionDate: event.distributionDate.toISOString().slice(0, 10) }, tokens: result.data.qrTokens });
    await writeFile(credentialPath, JSON.stringify(saved), { mode: 0o600 });
  }
  let qrBackendPreviewsChecked = 0;
  for (const card of saved.cards) {
    const credential = card.tokens[0];
    if (new Date(credential.expiresAt) <= new Date()) continue;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/distributions/${card.distribution.distributionId}/claims/preview-qr`, {
      method: 'POST', headers: { authorization: `Bearer ${authSession.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ token: credential.token }),
    });
    const preview = await response.json();
    if (response.status === 409 && ['DUPLICATE_CLAIM', 'QR_TOKEN_ALREADY_USED'].includes(preview.error?.code)) continue; // A used run is preserved, never reset.
    assert.equal(response.status, 200, `QR preview failed: ${preview.error?.code || 'unknown error'}`);
    assert.equal(preview.data.beneficiary.beneficiaryId, credential.beneficiaryId);
    qrBackendPreviewsChecked++;
  }
  const summary = { demoOnly: true, programCode: marker, qrBackendPreviewsChecked, events: events.map((item) => ({ title: item.title, distributionId: item.distributionId, method: item.verificationRequirement })), credentialsFile: saved.cards.length ? credentialPath : null,
    faceParticipant: uuid('Face'), guidance: 'No claims, biometric profiles, consent, releases, receipts, SMS or email were created. Existing runs are preserved; use a new --run label for a fresh rehearsal.' };
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (authSession) await prisma.staffSession.deleteMany({ where: { sessionId: authSession.sessionId } });
  if (server) await new Promise((resolveClose) => { server.close(resolveClose); server.closeAllConnections(); });
  await prisma.$disconnect();
}
