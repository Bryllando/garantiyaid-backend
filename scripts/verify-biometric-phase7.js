import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import app from "../src/app.js";
import prisma from "../src/lib/prisma.js";
import { issueAccessToken } from "../src/modules/auth/auth.service.js";

let server;
let baseUrl;
const temporaryProgramIds = [];
const temporaryBeneficiaryIds = [];
const temporaryEnrollmentIds = [];
const temporaryDistributionIds = [];
const temporaryAllocationIds = [];
const temporaryScheduleIds = [];
const temporaryQrTokenIds = [];
const temporaryClaimIds = [];
const temporarySessionIds = [];

async function accessToken(user) {
  const session = await issueAccessToken(user, { ipAddress: "127.0.0.1" });
  temporarySessionIds.push(session.sessionId);
  return session.accessToken;
}

async function jsonRequest(path, { method = "GET", token, body, idempotencyKey } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { response, payload: await response.json() };
}

async function multipartRequest(path, {
  token,
  capture,
  fields = {},
  idempotencyKey,
  method = "POST",
} = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  if (capture) {
    form.append("faceCapture", new Blob([capture.buffer], { type: capture.mimetype }), "capture.png");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: form,
  });
  return { response, payload: await response.json() };
}

function requireStatus(result, expectedStatus, step) {
  if (result.response.status !== expectedStatus) {
    throw new Error(`${step} returned ${result.response.status}: ${JSON.stringify(result.payload)}`);
  }
}

function requireError(result, expectedCode, step) {
  if (result.payload.error?.code !== expectedCode) {
    throw new Error(`${step} returned ${result.payload.error?.code}: ${JSON.stringify(result.payload)}`);
  }
}

function pngCapture(seed, lowEntropy = false) {
  const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (lowEntropy) return { buffer: Buffer.concat([header, Buffer.alloc(2048, 65)]), mimetype: "image/png" };
  const chunks = [header];
  for (let index = 0; index < 40; index += 1) {
    chunks.push(createHash("sha512").update(`${seed}:${index}`).digest());
  }
  return { buffer: Buffer.concat(chunks), mimetype: "image/png" };
}

function futureDate(offsetDays) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function unusedDate(barangayId) {
  for (let offset = 1900; offset <= 2200; offset += 1) {
    const value = futureDate(offset);
    const count = await prisma.distribution.count({
      where: { barangayId, distributionDate: new Date(`${value}T00:00:00.000Z`) },
    });
    if (count === 0) return value;
  }
  throw new Error("No unused future date is available for biometric verification.");
}

async function cleanup() {
  if (temporaryDistributionIds.length > 0) {
    await prisma.idempotencyRecord.deleteMany({
      where: {
        OR: temporaryDistributionIds.map((distributionId) => ({
          operation: { contains: distributionId },
        })),
      },
    });
  }
  const [attempts, scanLogs, profiles, consents, transactions, wallets] = await Promise.all([
    prisma.biometricVerificationAttempt.findMany({
      where: { beneficiaryId: { in: temporaryBeneficiaryIds } },
      select: { attemptId: true },
    }),
    prisma.qrScanLog.findMany({
      where: { distributionId: { in: temporaryDistributionIds } },
      select: { scanLogId: true },
    }),
    prisma.biometricData.findMany({
      where: { beneficiaryId: { in: temporaryBeneficiaryIds } },
      select: { biometricId: true },
    }),
    prisma.biometricConsent.findMany({
      where: { beneficiaryId: { in: temporaryBeneficiaryIds } },
      select: { consentId: true },
    }),
    prisma.transaction.findMany({
      where: { distributionId: { in: temporaryDistributionIds } },
      select: { transactionId: true },
    }),
    prisma.walletAccount.findMany({
      where: { beneficiaryId: { in: temporaryBeneficiaryIds } },
      select: { walletId: true },
    }),
  ]);
  const auditIds = [
    ...temporaryProgramIds,
    ...temporaryBeneficiaryIds,
    ...temporaryEnrollmentIds,
    ...temporaryDistributionIds,
    ...temporaryAllocationIds,
    ...temporaryScheduleIds,
    ...temporaryQrTokenIds,
    ...temporaryClaimIds,
    ...attempts.map((row) => row.attemptId),
    ...scanLogs.map((row) => row.scanLogId),
    ...profiles.map((row) => row.biometricId),
    ...consents.map((row) => row.consentId),
    ...transactions.map((row) => row.transactionId),
    ...wallets.map((row) => row.walletId),
  ];
  if (auditIds.length > 0) await prisma.auditLog.deleteMany({ where: { recordId: { in: auditIds } } });
  if (attempts.length > 0) {
    await prisma.biometricVerificationAttempt.deleteMany({
      where: { attemptId: { in: attempts.map((row) => row.attemptId) } },
    });
  }
  if (transactions.length > 0) {
    await prisma.transaction.deleteMany({
      where: { transactionId: { in: transactions.map((row) => row.transactionId) } },
    });
  }
  if (scanLogs.length > 0) {
    await prisma.qrScanLog.deleteMany({
      where: { scanLogId: { in: scanLogs.map((row) => row.scanLogId) } },
    });
  }
  if (temporaryClaimIds.length > 0) await prisma.claim.deleteMany({ where: { claimId: { in: temporaryClaimIds } } });
  if (temporaryQrTokenIds.length > 0) await prisma.qrToken.deleteMany({ where: { qrTokenId: { in: temporaryQrTokenIds } } });
  if (temporaryScheduleIds.length > 0) await prisma.schedule.deleteMany({ where: { scheduleId: { in: temporaryScheduleIds } } });
  if (temporaryAllocationIds.length > 0) await prisma.distributionAllocation.deleteMany({ where: { allocationId: { in: temporaryAllocationIds } } });
  if (temporaryDistributionIds.length > 0) {
    await prisma.distributionSlot.deleteMany({ where: { distributionId: { in: temporaryDistributionIds } } });
    await prisma.distribution.deleteMany({ where: { distributionId: { in: temporaryDistributionIds } } });
  }
  if (profiles.length > 0) await prisma.biometricData.deleteMany({ where: { biometricId: { in: profiles.map((row) => row.biometricId) } } });
  if (consents.length > 0) await prisma.biometricConsent.deleteMany({ where: { consentId: { in: consents.map((row) => row.consentId) } } });
  if (wallets.length > 0) await prisma.walletAccount.deleteMany({ where: { walletId: { in: wallets.map((row) => row.walletId) } } });
  if (temporaryEnrollmentIds.length > 0) await prisma.enrollment.deleteMany({ where: { enrollmentId: { in: temporaryEnrollmentIds } } });
  if (temporaryBeneficiaryIds.length > 0) await prisma.beneficiary.deleteMany({ where: { beneficiaryId: { in: temporaryBeneficiaryIds } } });
  if (temporaryProgramIds.length > 0) await prisma.program.deleteMany({ where: { programId: { in: temporaryProgramIds } } });
  if (temporarySessionIds.length > 0) await prisma.staffSession.deleteMany({ where: { sessionId: { in: temporarySessionIds } } });
}

try {
  const [administrator, dswd, facilitator] = await Promise.all([
    prisma.user.findFirst({ where: { role: "SYSTEM_ADMIN", isActive: true } }),
    prisma.user.findFirst({ where: { role: "DSWD_STAFF", isActive: true } }),
    prisma.user.findFirst({
      where: {
        role: "BARANGAY_FACILITATOR",
        isActive: true,
        barangayId: { not: null },
        barangay: { isActive: true },
      },
    }),
  ]);
  if (!administrator || !dswd || !facilitator) {
    throw new Error("Active Admin, DSWD, and assigned Barangay users are required.");
  }
  const [adminToken, dswdToken, facilitatorToken] = await Promise.all([
    accessToken(administrator),
    accessToken(dswd),
    accessToken(facilitator),
  ]);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  const suffix = Date.now().toString().slice(-10);
  const program = await prisma.program.create({
    data: {
      programName: `Temporary Biometric Program ${suffix}`,
      programCode: `BIO-${suffix}`,
      programType: "CASH_ASSISTANCE",
      description: "Temporary biometric verification fixture.",
      grantAmount: 1000,
      budgetAmount: 10000,
      status: "ACTIVE",
      createdById: administrator.userId,
    },
  });
  temporaryProgramIds.push(program.programId);

  const beneficiaries = [];
  for (const [index, firstName] of ["Alpha", "Bravo", "Charlie"].entries()) {
    const beneficiary = await prisma.beneficiary.create({
      data: {
        firstName,
        lastName: `BiometricVerify${suffix}`,
        birthDate: new Date(`198${index}-01-01T00:00:00.000Z`),
        sex: index === 1 ? "FEMALE" : "MALE",
        address: "Temporary biometric verification address",
        barangayId: facilitator.barangayId,
        isVerified: true,
        status: "ACTIVE",
      },
    });
    temporaryBeneficiaryIds.push(beneficiary.beneficiaryId);
    beneficiaries.push(beneficiary);
  }
  const enrollments = [];
  for (const beneficiary of beneficiaries) {
    const enrollment = await prisma.enrollment.create({
      data: {
        beneficiaryId: beneficiary.beneficiaryId,
        programId: program.programId,
        submittedById: facilitator.userId,
        status: "APPROVED",
        reviewedById: dswd.userId,
        reviewedAt: new Date(),
      },
    });
    temporaryEnrollmentIds.push(enrollment.enrollmentId);
    enrollments.push(enrollment);
  }

  const date = await unusedDate(facilitator.barangayId);
  const distribution = await prisma.distribution.create({
    data: {
      programId: program.programId,
      createdById: administrator.userId,
      title: `Temporary Biometric Verification Event ${suffix}`,
      distributionDate: new Date(`${date}T00:00:00.000Z`),
      startTime: new Date("1970-01-01T08:00:00.000Z"),
      endTime: new Date("1970-01-01T09:00:00.000Z"),
      slotDurationMinutes: 30,
      location: "Temporary biometric hall",
      barangayId: facilitator.barangayId,
      status: "DRAFT",
      verificationRequirement: "QR_AND_BIOMETRIC",
    },
  });
  temporaryDistributionIds.push(distribution.distributionId);
  const slot = await prisma.distributionSlot.create({
    data: {
      distributionId: distribution.distributionId,
      slotStart: new Date(`${date}T00:00:00.000Z`),
      slotEnd: new Date(`${date}T00:30:00.000Z`),
      capacity: 3,
      slotStatus: "FULL",
    },
  });
  for (let index = 0; index < beneficiaries.length; index += 1) {
    const allocation = await prisma.distributionAllocation.create({
      data: {
        distributionId: distribution.distributionId,
        beneficiaryId: beneficiaries[index].beneficiaryId,
        enrollmentId: enrollments[index].enrollmentId,
        amount: 1000,
        allocationStatus: "ALLOCATED",
        allocatedById: administrator.userId,
        allocatedAt: new Date(),
      },
    });
    temporaryAllocationIds.push(allocation.allocationId);
    const schedule = await prisma.schedule.create({
      data: {
        distributionId: distribution.distributionId,
        beneficiaryId: beneficiaries[index].beneficiaryId,
        slotId: slot.slotId,
        queueNumber: index + 1,
        status: "SCHEDULED",
      },
    });
    temporaryScheduleIds.push(schedule.scheduleId);
  }
  const opened = await jsonRequest(`/distributions/${distribution.distributionId}/open`, {
    method: "POST",
    token: adminToken,
  });
  requireStatus(opened, 200, "opening combined-verification distribution");

  const captures = beneficiaries.map((beneficiary) => pngCapture(beneficiary.beneficiaryId));
  const noConsent = await multipartRequest(
    `/beneficiaries/${beneficiaries[0].beneficiaryId}/biometrics/enroll`,
    { token: facilitatorToken, capture: captures[0] },
  );
  requireStatus(noConsent, 409, "enrollment without consent");
  requireError(noConsent, "ACTIVE_BIOMETRIC_CONSENT_REQUIRED", "enrollment without consent");

  const retentionUntil = new Date(Date.now() + 365 * 86_400_000).toISOString();
  const consents = [];
  for (const beneficiary of beneficiaries) {
    const consent = await jsonRequest(`/beneficiaries/${beneficiary.beneficiaryId}/biometric-consents`, {
      method: "POST",
      token: facilitatorToken,
      body: { consentVersion: "v1.0", consentGiven: true, retentionUntil },
    });
    requireStatus(consent, 201, "recording biometric consent");
    consents.push(consent.payload.data.consent);
  }
  const consentHistory = await jsonRequest(
    `/beneficiaries/${beneficiaries[0].beneficiaryId}/biometric-consents`,
    { token: dswdToken },
  );
  requireStatus(consentHistory, 200, "DSWD consent-history read");
  if (consentHistory.payload.data.consents[0].consentStatus !== "ACTIVE") {
    throw new Error("Consent history did not expose safe ACTIVE metadata.");
  }

  const forbiddenEnrollment = await multipartRequest(
    `/beneficiaries/${beneficiaries[0].beneficiaryId}/biometrics/enroll`,
    { token: dswdToken, capture: captures[0], fields: { consentId: consents[0].consentId } },
  );
  requireStatus(forbiddenEnrollment, 403, "DSWD enrollment restriction");
  for (let index = 0; index < beneficiaries.length; index += 1) {
    const enrolled = await multipartRequest(
      `/beneficiaries/${beneficiaries[index].beneficiaryId}/biometrics/enroll`,
      {
        token: facilitatorToken,
        capture: captures[index],
        fields: { consentId: consents[index].consentId },
      },
    );
    requireStatus(enrolled, 201, "biometric enrollment");
    const serialized = JSON.stringify(enrolled.payload);
    if (
      serialized.includes("faceEmbedding")
      || enrolled.payload.data.biometricProfile.biometricStatus !== "ENROLLED"
      || enrolled.payload.data.processing.rawCaptureStored !== false
    ) throw new Error("Biometric enrollment response exposed a template or incorrect lifecycle.");
  }
  const duplicateEnrollment = await multipartRequest(
    `/beneficiaries/${beneficiaries[0].beneficiaryId}/biometrics/enroll`,
    { token: facilitatorToken, capture: captures[0], fields: { consentId: consents[0].consentId } },
  );
  requireStatus(duplicateEnrollment, 409, "duplicate enrollment protection");
  requireError(duplicateEnrollment, "BIOMETRIC_PROFILE_ALREADY_EXISTS", "duplicate enrollment protection");
  const reenrolled = await multipartRequest(
    `/beneficiaries/${beneficiaries[0].beneficiaryId}/biometrics/re-enroll`,
    { token: facilitatorToken, capture: captures[0], fields: { consentId: consents[0].consentId } },
  );
  requireStatus(reenrolled, 200, "biometric re-enrollment");

  const storedProfile = await prisma.biometricData.findUnique({
    where: { beneficiaryId: beneficiaries[0].beneficiaryId },
    select: { faceEmbedding: true, dataStatus: true },
  });
  if (
    storedProfile.dataStatus !== "ACTIVE"
    || storedProfile.faceEmbedding.subarray(0, 1).toString("utf8") === "["
    || storedProfile.faceEmbedding.includes(captures[0].buffer)
  ) throw new Error("Biometric template was not stored as an encrypted, non-image value.");

  const generated = await jsonRequest(
    `/distributions/${distribution.distributionId}/qr-tokens/generate`,
    { method: "POST", token: adminToken, body: {} },
  );
  requireStatus(generated, 201, "combined-verification QR generation");
  temporaryQrTokenIds.push(...generated.payload.data.qrTokens.map((row) => row.qrTokenId));
  const tokenByBeneficiary = new Map(
    generated.payload.data.qrTokens.map((row) => [row.beneficiaryId, row.token]),
  );

  const alphaQr = await jsonRequest(`/distributions/${distribution.distributionId}/claims/verify-qr`, {
    method: "POST",
    token: facilitatorToken,
    idempotencyKey: randomUUID(),
    body: { token: tokenByBeneficiary.get(beneficiaries[0].beneficiaryId), deviceInfo: "QR-first verification" },
  });
  requireStatus(alphaQr, 201, "QR-first partial claim");
  temporaryClaimIds.push(alphaQr.payload.data.claim.claimId);
  if (
    alphaQr.payload.data.claim.claimStatus !== "PENDING"
    || alphaQr.payload.data.nextRequiredVerification !== "BIOMETRIC"
  ) throw new Error("QR-first combined flow did not stop at PENDING biometric verification.");

  const alphaBiometricKey = randomUUID();
  const alphaBiometric = await multipartRequest(
    `/distributions/${distribution.distributionId}/claims/verify-biometric`,
    {
      token: facilitatorToken,
      capture: captures[0],
      idempotencyKey: alphaBiometricKey,
      fields: { beneficiaryId: beneficiaries[0].beneficiaryId, deviceInfo: "Biometric-second verification" },
    },
  );
  requireStatus(alphaBiometric, 201, "biometric completion after QR");
  if (
    alphaBiometric.payload.data.claim.claimStatus !== "VERIFIED"
    || !alphaBiometric.payload.data.claim.qrVerified
    || !alphaBiometric.payload.data.claim.biometricVerified
  ) throw new Error("QR-first combined claim was not fully verified.");
  const alphaReplay = await multipartRequest(
    `/distributions/${distribution.distributionId}/claims/verify-biometric`,
    {
      token: facilitatorToken,
      capture: captures[0],
      idempotencyKey: alphaBiometricKey,
      fields: { beneficiaryId: beneficiaries[0].beneficiaryId, deviceInfo: "Biometric-second verification" },
    },
  );
  requireStatus(alphaReplay, 201, "biometric idempotent replay");
  if (
    alphaReplay.response.headers.get("idempotency-replayed") !== "true"
    || alphaReplay.payload.data.claim.claimId !== alphaBiometric.payload.data.claim.claimId
  ) throw new Error("Biometric replay did not return the original claim.");

  const livenessFailure = await multipartRequest(
    `/distributions/${distribution.distributionId}/claims/verify-biometric`,
    {
      token: facilitatorToken,
      capture: pngCapture("spoof", true),
      idempotencyKey: randomUUID(),
      fields: { beneficiaryId: beneficiaries[1].beneficiaryId, deviceInfo: "Spoof verification capture" },
    },
  );
  requireStatus(livenessFailure, 422, "liveness failure");
  requireError(livenessFailure, "BIOMETRIC_LIVENESS_FAILED", "liveness failure");
  const noMatch = await multipartRequest(
    `/distributions/${distribution.distributionId}/claims/verify-biometric`,
    {
      token: facilitatorToken,
      capture: captures[0],
      idempotencyKey: randomUUID(),
      fields: { beneficiaryId: beneficiaries[1].beneficiaryId, deviceInfo: "Mismatch verification capture" },
    },
  );
  requireStatus(noMatch, 422, "face mismatch");
  requireError(noMatch, "BIOMETRIC_NO_MATCH", "face mismatch");
  const bravoBiometric = await multipartRequest(
    `/distributions/${distribution.distributionId}/claims/verify-biometric`,
    {
      token: facilitatorToken,
      capture: captures[1],
      idempotencyKey: randomUUID(),
      fields: { beneficiaryId: beneficiaries[1].beneficiaryId, deviceInfo: "Biometric-first verification" },
    },
  );
  requireStatus(bravoBiometric, 201, "biometric-first partial claim");
  temporaryClaimIds.push(bravoBiometric.payload.data.claim.claimId);
  if (
    bravoBiometric.payload.data.claim.claimStatus !== "PENDING"
    || bravoBiometric.payload.data.nextRequiredVerification !== "QR"
  ) throw new Error("Biometric-first flow did not stop at PENDING QR verification.");
  const bravoQr = await jsonRequest(`/distributions/${distribution.distributionId}/claims/verify-qr`, {
    method: "POST",
    token: facilitatorToken,
    idempotencyKey: randomUUID(),
    body: { token: tokenByBeneficiary.get(beneficiaries[1].beneficiaryId), deviceInfo: "QR-second verification" },
  });
  requireStatus(bravoQr, 201, "QR completion after biometric");
  if (
    bravoQr.payload.data.claim.claimStatus !== "VERIFIED"
    || !bravoQr.payload.data.claim.qrVerified
    || !bravoQr.payload.data.claim.biometricVerified
  ) throw new Error("Biometric-first combined claim was not fully verified.");

  const forbiddenVerification = await multipartRequest(
    `/distributions/${distribution.distributionId}/claims/verify-biometric`,
    {
      token: dswdToken,
      capture: captures[2],
      idempotencyKey: randomUUID(),
      fields: { beneficiaryId: beneficiaries[2].beneficiaryId },
    },
  );
  requireStatus(forbiddenVerification, 403, "DSWD biometric-verification restriction");
  const revoked = await jsonRequest(
    `/beneficiaries/${beneficiaries[2].beneficiaryId}/biometric-consents/${consents[2].consentId}/revoke`,
    { method: "POST", token: facilitatorToken },
  );
  requireStatus(revoked, 200, "consent revocation");
  const blockedAfterRevocation = await multipartRequest(
    `/distributions/${distribution.distributionId}/claims/verify-biometric`,
    {
      token: facilitatorToken,
      capture: captures[2],
      idempotencyKey: randomUUID(),
      fields: { beneficiaryId: beneficiaries[2].beneficiaryId, deviceInfo: "Revoked consent test" },
    },
  );
  requireStatus(blockedAfterRevocation, 409, "verification after consent revocation");
  requireError(blockedAfterRevocation, "BIOMETRIC_CONSENT_INVALID", "verification after consent revocation");
  const forbiddenDelete = await jsonRequest(`/beneficiaries/${beneficiaries[2].beneficiaryId}/biometrics`, {
    method: "DELETE",
    token: dswdToken,
  });
  requireStatus(forbiddenDelete, 403, "DSWD biometric deletion restriction");
  const deleted = await jsonRequest(`/beneficiaries/${beneficiaries[2].beneficiaryId}/biometrics`, {
    method: "DELETE",
    token: adminToken,
  });
  requireStatus(deleted, 200, "permanent biometric deletion");
  const deletedStatus = await jsonRequest(
    `/beneficiaries/${beneficiaries[2].beneficiaryId}/biometrics/status`,
    { token: dswdToken },
  );
  requireStatus(deletedStatus, 200, "status after deletion");
  if (deletedStatus.payload.data.biometricProfile.biometricStatus !== "NOT_ENROLLED") {
    throw new Error("Deleted biometric profile still appears enrolled.");
  }

  const attempts = await jsonRequest(
    `/distributions/${distribution.distributionId}/biometric-attempts?page=1&pageSize=100`,
    { token: dswdToken },
  );
  requireStatus(attempts, 200, "biometric attempt monitoring");
  const results = new Set(attempts.payload.data.attempts.map((row) => row.result));
  for (const expected of ["MATCHED", "NO_MATCH", "LIVENESS_FAILED", "CONSENT_INVALID"]) {
    if (!results.has(expected)) throw new Error(`Biometric attempts are missing ${expected}.`);
  }
  const serializedAttempts = JSON.stringify(attempts.payload);
  if (serializedAttempts.includes("faceEmbedding") || serializedAttempts.includes("faceCapture")) {
    throw new Error("Biometric monitoring exposed a template or raw capture.");
  }

  const credited = await jsonRequest(
    `/distributions/${distribution.distributionId}/claims/${alphaBiometric.payload.data.claim.claimId}/credit`,
    {
      method: "POST",
      token: dswdToken,
      idempotencyKey: randomUUID(),
      body: { description: "Combined identity verification credit test" },
    },
  );
  requireStatus(credited, 201, "wallet credit after combined verification");
  if (
    credited.payload.data.lifecycle.claimStatus !== "CLAIMED"
    || credited.payload.data.wallet.balance !== "1000"
  ) throw new Error("Combined identity verification did not integrate with wallet credit.");

  console.log("Biometric consent and identity verification passed.");
  console.log("Verified consent gating/history, transient captures, encrypted templates, RBAC,");
  console.log("re-enrollment, QR-first and biometric-first combined claims, replay protection,");
  console.log("liveness/no-match logging, revocation/deletion, privacy, and wallet-credit compatibility.");
} finally {
  if (server) {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  await cleanup();
  await prisma.$disconnect();
}
