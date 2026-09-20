import { randomUUID } from "node:crypto";
import { once } from "node:events";
import app from "../src/app.js";
import prisma from "../src/lib/prisma.js";
import { issueAccessToken } from "../src/modules/auth/auth.service.js";
import { hashQrToken } from "../src/modules/distributions/distributionClaim.service.js";

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

async function verificationAccessToken(user) {
  const session = await issueAccessToken(user, { ipAddress: "127.0.0.1" });
  temporarySessionIds.push(session.sessionId);
  return session.accessToken;
}

async function request(path, {
  method = "GET",
  token,
  body,
  idempotencyKey,
} = {}) {
  const hasJsonBody = body !== undefined;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(hasJsonBody ? { "content-type": "application/json" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    ...(hasJsonBody ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  return { response, payload };
}

function requireStatus(result, expectedStatus, step) {
  if (result.response.status !== expectedStatus) {
    throw new Error(`${step} returned ${result.response.status}: ${JSON.stringify(result.payload)}`);
  }
}

function requireErrorCode(result, expectedCode, step) {
  if (result.payload.error?.code !== expectedCode) {
    throw new Error(
      `${step} returned error ${result.payload.error?.code}: ${JSON.stringify(result.payload)}`,
    );
  }
}

function futureDate(offsetDays) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

async function unusedDistributionDate(barangayId) {
  for (let offsetDays = 1500; offsetDays <= 1800; offsetDays += 1) {
    const date = futureDate(offsetDays);
    const existing = await prisma.distribution.count({
      where: {
        barangayId,
        distributionDate: new Date(`${date}T00:00:00.000Z`),
      },
    });
    if (existing === 0) {
      return date;
    }
  }
  throw new Error("Could not find an unused future date for claim verification.");
}

async function cleanup() {
  if (temporaryDistributionIds.length > 0) {
    await prisma.idempotencyRecord.deleteMany({
      where: {
        operation: {
          in: temporaryDistributionIds.map((id) => `QR_CLAIM_VERIFY:${id}`),
        },
      },
    });
  }
  const auditRecordIds = [
    ...temporaryDistributionIds,
    ...temporaryAllocationIds,
    ...temporaryScheduleIds,
    ...temporaryQrTokenIds,
    ...temporaryClaimIds,
  ];
  if (auditRecordIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { recordId: { in: auditRecordIds } } });
  }
  if (temporaryDistributionIds.length > 0) {
    const scanLogs = await prisma.qrScanLog.findMany({
      where: { distributionId: { in: temporaryDistributionIds } },
      select: { scanLogId: true },
    });
    const scanLogIds = scanLogs.map((row) => row.scanLogId);
    if (scanLogIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { recordId: { in: scanLogIds } } });
    }
    await prisma.qrScanLog.deleteMany({
      where: { distributionId: { in: temporaryDistributionIds } },
    });
  }
  if (temporaryClaimIds.length > 0) {
    await prisma.claim.deleteMany({ where: { claimId: { in: temporaryClaimIds } } });
  }
  if (temporaryQrTokenIds.length > 0) {
    await prisma.qrToken.deleteMany({
      where: { qrTokenId: { in: temporaryQrTokenIds } },
    });
  }
  if (temporaryScheduleIds.length > 0) {
    await prisma.schedule.deleteMany({
      where: { scheduleId: { in: temporaryScheduleIds } },
    });
  }
  if (temporaryAllocationIds.length > 0) {
    await prisma.distributionAllocation.deleteMany({
      where: { allocationId: { in: temporaryAllocationIds } },
    });
  }
  if (temporaryDistributionIds.length > 0) {
    await prisma.distributionSlot.deleteMany({
      where: { distributionId: { in: temporaryDistributionIds } },
    });
    await prisma.distribution.deleteMany({
      where: { distributionId: { in: temporaryDistributionIds } },
    });
  }
  if (temporaryEnrollmentIds.length > 0) {
    await prisma.enrollment.deleteMany({
      where: { enrollmentId: { in: temporaryEnrollmentIds } },
    });
  }
  if (temporaryBeneficiaryIds.length > 0) {
    await prisma.beneficiary.deleteMany({
      where: { beneficiaryId: { in: temporaryBeneficiaryIds } },
    });
  }
  if (temporaryProgramIds.length > 0) {
    await prisma.program.deleteMany({ where: { programId: { in: temporaryProgramIds } } });
  }
  if (temporarySessionIds.length > 0) {
    await prisma.staffSession.deleteMany({
      where: { sessionId: { in: temporarySessionIds } },
    });
  }
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
    throw new Error(
      "Active SYSTEM_ADMIN, DSWD_STAFF, and assigned BARANGAY_FACILITATOR are required.",
    );
  }
  const [adminToken, dswdToken, facilitatorToken] = await Promise.all([
    verificationAccessToken(administrator),
    verificationAccessToken(dswd),
    verificationAccessToken(facilitator),
  ]);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  const suffix = Date.now().toString().slice(-10);
  const program = await prisma.program.create({
    data: {
      programName: `Temporary QR Claim Program ${suffix}`,
      programCode: `QRC-${suffix}`,
      programType: "CASH_ASSISTANCE",
      description: "Temporary claim verification record.",
      grantAmount: 1000,
      budgetAmount: 10000,
      status: "ACTIVE",
      createdById: administrator.userId,
    },
  });
  temporaryProgramIds.push(program.programId);

  const beneficiaries = [];
  for (const [index, firstName] of ["Echo", "Foxtrot"].entries()) {
    const beneficiary = await prisma.beneficiary.create({
      data: {
        firstName,
        lastName: `ClaimVerify${suffix}`,
        birthDate: new Date(`198${index}-01-01T00:00:00.000Z`),
        sex: index === 0 ? "FEMALE" : "MALE",
        address: "Temporary verification address",
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

  const distributionDate = await unusedDistributionDate(facilitator.barangayId);
  const distribution = await prisma.distribution.create({
    data: {
      programId: program.programId,
      createdById: administrator.userId,
      title: `Temporary Claim Verification Event ${suffix}`,
      distributionDate: new Date(`${distributionDate}T00:00:00.000Z`),
      startTime: new Date("1970-01-01T08:00:00.000Z"),
      endTime: new Date("1970-01-01T09:00:00.000Z"),
      slotDurationMinutes: 30,
      location: "Temporary QR Verification Hall",
      barangayId: facilitator.barangayId,
      status: "DRAFT",
    },
  });
  temporaryDistributionIds.push(distribution.distributionId);
  const slots = await Promise.all([
    prisma.distributionSlot.create({
      data: {
        distributionId: distribution.distributionId,
        slotStart: new Date(`${distributionDate}T00:00:00.000Z`),
        slotEnd: new Date(`${distributionDate}T00:30:00.000Z`),
        capacity: 1,
        slotStatus: "FULL",
      },
    }),
    prisma.distributionSlot.create({
      data: {
        distributionId: distribution.distributionId,
        slotStart: new Date(`${distributionDate}T00:30:00.000Z`),
        slotEnd: new Date(`${distributionDate}T01:00:00.000Z`),
        capacity: 1,
        slotStatus: "FULL",
      },
    }),
  ]);

  const allocations = [];
  const schedules = [];
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
    allocations.push(allocation);
    const schedule = await prisma.schedule.create({
      data: {
        distributionId: distribution.distributionId,
        beneficiaryId: beneficiaries[index].beneficiaryId,
        slotId: slots[index].slotId,
        queueNumber: 1,
        status: "SCHEDULED",
      },
    });
    temporaryScheduleIds.push(schedule.scheduleId);
    schedules.push(schedule);
  }

  const draftGeneration = await request(
    `/distributions/${distribution.distributionId}/qr-tokens/generate`,
    { method: "POST", token: adminToken, body: {} },
  );
  requireStatus(draftGeneration, 409, "draft-event QR generation protection");
  requireErrorCode(
    draftGeneration,
    "DISTRIBUTION_NOT_OPEN_FOR_CLAIMS",
    "draft-event QR generation protection",
  );

  const opened = await request(`/distributions/${distribution.distributionId}/open`, {
    method: "POST",
    token: adminToken,
  });
  requireStatus(opened, 200, "distribution OPEN transition");

  const eligible = await request(
    `/distributions/${distribution.distributionId}/qr-eligible-schedules?page=1&pageSize=20`,
    { token: facilitatorToken },
  );
  requireStatus(eligible, 200, "facilitator QR-eligible schedule read");
  if (eligible.payload.data.summary.qrEligibleScheduleCount !== 2) {
    throw new Error("QR-eligible schedule list did not return both active schedules.");
  }

  const forbiddenGeneration = await request(
    `/distributions/${distribution.distributionId}/qr-tokens/generate`,
    { method: "POST", token: dswdToken, body: {} },
  );
  requireStatus(forbiddenGeneration, 403, "DSWD token-generation protection");

  const generated = await request(
    `/distributions/${distribution.distributionId}/qr-tokens/generate`,
    { method: "POST", token: adminToken, body: {} },
  );
  requireStatus(generated, 201, "batch QR-token generation");
  const generatedTokens = generated.payload.data.qrTokens;
  if (generatedTokens.length !== 2 || generatedTokens.some((row) => !row.token)) {
    throw new Error("QR generation did not return exactly two one-time raw tokens.");
  }
  temporaryQrTokenIds.push(...generatedTokens.map((row) => row.qrTokenId));
  const firstToken = generatedTokens.find(
    (row) => row.beneficiaryId === beneficiaries[0].beneficiaryId,
  );
  if (!firstToken) {
    throw new Error("Could not identify the first beneficiary's generated QR token.");
  }
  const storedToken = await prisma.qrToken.findUnique({
    where: { qrTokenId: firstToken.qrTokenId },
    select: { tokenHash: true },
  });
  if (
    storedToken.tokenHash !== hashQrToken(firstToken.token)
    || storedToken.tokenHash === firstToken.token
  ) {
    throw new Error("The database did not store only the QR token hash.");
  }

  const listedTokens = await request(
    `/distributions/${distribution.distributionId}/qr-tokens?page=1&pageSize=20`,
    { token: dswdToken },
  );
  requireStatus(listedTokens, 200, "DSWD QR monitoring");
  const serializedTokens = JSON.stringify(listedTokens.payload);
  if (serializedTokens.includes(firstToken.token) || serializedTokens.includes("tokenHash")) {
    throw new Error("QR monitoring exposed a raw token or token hash.");
  }

  const revoked = await request(
    `/distributions/${distribution.distributionId}/qr-tokens/${firstToken.qrTokenId}/revoke`,
    { method: "POST", token: adminToken },
  );
  requireStatus(revoked, 200, "QR-token revocation");
  if (revoked.payload.data.qrToken.qrStatus !== "REVOKED") {
    throw new Error("QR revocation did not set REVOKED status.");
  }

  const revokedScan = await request(
    `/distributions/${distribution.distributionId}/claims/verify-qr`,
    {
      method: "POST",
      token: facilitatorToken,
      idempotencyKey: randomUUID(),
      body: { token: firstToken.token, deviceInfo: "Claim verification device" },
    },
  );
  requireStatus(revokedScan, 409, "revoked-token scan protection");
  requireErrorCode(revokedScan, "QR_TOKEN_REVOKED", "revoked-token scan protection");

  const reissued = await request(
    `/distributions/${distribution.distributionId}/qr-tokens/${firstToken.qrTokenId}/reissue`,
    { method: "POST", token: adminToken },
  );
  requireStatus(reissued, 200, "QR-token reissue");
  const reissuedRawToken = reissued.payload.data.qrToken.token;
  if (!reissuedRawToken || reissuedRawToken === firstToken.token) {
    throw new Error("QR reissue did not return a new one-time raw token.");
  }

  const invalidOldToken = await request(
    `/distributions/${distribution.distributionId}/claims/verify-qr`,
    {
      method: "POST",
      token: facilitatorToken,
      idempotencyKey: randomUUID(),
      body: { token: firstToken.token, deviceInfo: "Old Token Test" },
    },
  );
  requireStatus(invalidOldToken, 404, "old-token invalidation after reissue");
  requireErrorCode(invalidOldToken, "INVALID_QR_TOKEN", "old-token invalidation after reissue");

  const transactionsBefore = await prisma.transaction.count();
  const verificationKey = randomUUID();
  const verified = await request(
    `/distributions/${distribution.distributionId}/claims/verify-qr`,
    {
      method: "POST",
      token: facilitatorToken,
      idempotencyKey: verificationKey,
      body: { token: reissuedRawToken, deviceInfo: "Barangay Scanner 01" },
    },
  );
  requireStatus(verified, 201, "successful QR claim verification");
  const claim = verified.payload.data.claim;
  temporaryClaimIds.push(claim.claimId);
  if (
    claim.claimStatus !== "VERIFIED"
    || claim.qrVerified !== true
    || claim.verificationMethod !== "QR"
    || verified.payload.data.walletTransactionCreated !== false
  ) {
    throw new Error("Successful QR verification did not stop at VERIFIED without a transaction.");
  }
  const [databaseSchedule, databaseAllocation, databaseToken, transactionsAfter] = await Promise.all([
    prisma.schedule.findUnique({ where: { scheduleId: schedules[0].scheduleId } }),
    prisma.distributionAllocation.findUnique({
      where: { allocationId: allocations[0].allocationId },
    }),
    prisma.qrToken.findUnique({ where: { qrTokenId: firstToken.qrTokenId } }),
    prisma.transaction.count(),
  ]);
  if (
    databaseSchedule.status !== "CHECKED_IN"
    || databaseAllocation.allocationStatus !== "ALLOCATED"
    || databaseToken.qrStatus !== "USED"
    || transactionsAfter !== transactionsBefore
  ) {
    throw new Error("QR verification lifecycle or wallet isolation is incorrect.");
  }

  const successfulScanCount = await prisma.qrScanLog.count({
    where: { distributionId: distribution.distributionId, scanResult: "VERIFIED" },
  });
  const replay = await request(
    `/distributions/${distribution.distributionId}/claims/verify-qr`,
    {
      method: "POST",
      token: facilitatorToken,
      idempotencyKey: verificationKey,
      body: { token: reissuedRawToken, deviceInfo: "Barangay Scanner 01" },
    },
  );
  requireStatus(replay, 201, "claim-verification idempotent replay");
  if (
    replay.response.headers.get("idempotency-replayed") !== "true"
    || replay.payload.data.claim.claimId !== claim.claimId
  ) {
    throw new Error("Claim-verification replay did not return the original claim.");
  }
  const successfulScanCountAfterReplay = await prisma.qrScanLog.count({
    where: { distributionId: distribution.distributionId, scanResult: "VERIFIED" },
  });
  if (successfulScanCountAfterReplay !== successfulScanCount) {
    throw new Error("Idempotent replay created another successful scan log.");
  }

  const duplicate = await request(
    `/distributions/${distribution.distributionId}/claims/verify-qr`,
    {
      method: "POST",
      token: facilitatorToken,
      idempotencyKey: randomUUID(),
      body: { token: reissuedRawToken, deviceInfo: "Duplicate Scan" },
    },
  );
  requireStatus(duplicate, 409, "one-time-use duplicate protection");
  requireErrorCode(duplicate, "QR_TOKEN_ALREADY_USED", "one-time-use duplicate protection");
  const duplicateClaim = await prisma.claim.findUnique({ where: { claimId: claim.claimId } });
  if (!duplicateClaim.isDuplicateFlag) {
    throw new Error("Duplicate scan did not flag the existing claim.");
  }

  const invalidToken = await request(
    `/distributions/${distribution.distributionId}/claims/verify-qr`,
    {
      method: "POST",
      token: facilitatorToken,
      idempotencyKey: randomUUID(),
      body: { token: `invalid_${randomUUID()}`, deviceInfo: "Invalid Scan" },
    },
  );
  requireStatus(invalidToken, 404, "invalid QR scan logging");
  requireErrorCode(invalidToken, "INVALID_QR_TOKEN", "invalid QR scan logging");

  const forbiddenVerification = await request(
    `/distributions/${distribution.distributionId}/claims/verify-qr`,
    {
      method: "POST",
      token: dswdToken,
      idempotencyKey: randomUUID(),
      body: { token: generatedTokens[1].token },
    },
  );
  requireStatus(forbiddenVerification, 403, "DSWD claim-verification protection");

  const claims = await request(
    `/distributions/${distribution.distributionId}/claims?status=VERIFIED&page=1&pageSize=20`,
    { token: dswdToken },
  );
  requireStatus(claims, 200, "DSWD claim monitoring");
  if (claims.payload.data.summary.matchingClaimCount !== 1) {
    throw new Error("Claim monitoring did not return the verified claim.");
  }
  const serializedClaim = JSON.stringify(claims.payload);
  for (const forbiddenField of [
    "address",
    "contactNumber",
    "email",
    "philsysNumber",
    "passwordHash",
    "tokenHash",
    "submittedTokenHash",
    "transactions",
  ]) {
    if (serializedClaim.includes(`\"${forbiddenField}\"`)) {
      throw new Error(`Claim response exposed sensitive/downstream field ${forbiddenField}.`);
    }
  }

  const scanLogs = await request(
    `/distributions/${distribution.distributionId}/qr-scan-logs?page=1&pageSize=20`,
    { token: facilitatorToken },
  );
  requireStatus(scanLogs, 200, "Barangay-scoped scan-log monitoring");
  const results = new Set(scanLogs.payload.data.scanLogs.map((row) => row.scanResult));
  for (const result of ["VERIFIED", "REVOKED", "INVALID_TOKEN", "DUPLICATE"]) {
    if (!results.has(result)) {
      throw new Error(`Scan-log monitoring is missing result ${result}.`);
    }
  }
  const serializedScanLogs = JSON.stringify(scanLogs.payload);
  if (
    serializedScanLogs.includes("submittedTokenHash")
    || serializedScanLogs.includes(reissuedRawToken)
  ) {
    throw new Error("Scan-log monitoring exposed submitted token material.");
  }

  console.log("QR and claim verification passed.");
  console.log("Verified OPEN-event gating, batch token generation, hash-only storage, role scope,");
  console.log("revocation/reissue, invalid and duplicate scan logs, one-time consumption,");
  console.log("idempotent replay, VERIFIED claims, privacy, audits, and wallet isolation.");
} finally {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await cleanup();
  await prisma.$disconnect();
}
