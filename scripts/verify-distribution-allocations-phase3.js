import { randomUUID } from "node:crypto";
import { once } from "node:events";
import app from "../src/app.js";
import prisma from "../src/lib/prisma.js";
import { issueAccessToken } from "../src/modules/auth/auth.service.js";

let server;
let baseUrl;
let temporaryBarangayId;
const temporaryProgramIds = [];
const temporaryBeneficiaryIds = [];
const temporaryEnrollmentIds = [];
const temporaryDistributionIds = [];
const temporaryAllocationIds = [];
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
    throw new Error(
      `${step} returned ${result.response.status}: ${JSON.stringify(result.payload)}`,
    );
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

async function unusedDistributionDate(barangayIds) {
  for (let offsetDays = 900; offsetDays <= 1200; offsetDays += 1) {
    const date = futureDate(offsetDays);
    const existing = await prisma.distribution.count({
      where: {
        barangayId: { in: barangayIds },
        distributionDate: new Date(`${date}T00:00:00.000Z`),
      },
    });
    if (existing === 0) {
      return date;
    }
  }

  throw new Error("Could not find an unused future date for allocation verification.");
}

async function cleanup() {
  if (temporaryDistributionIds.length > 0) {
    await prisma.idempotencyRecord.deleteMany({
      where: {
        operation: {
          in: temporaryDistributionIds.map((id) => `DISTRIBUTION_ALLOCATION_BATCH:${id}`),
        },
      },
    });
  }
  const auditRecordIds = [
    ...temporaryDistributionIds,
    ...temporaryAllocationIds,
  ];
  if (auditRecordIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { recordId: { in: auditRecordIds } } });
  }
  if (temporaryAllocationIds.length > 0) {
    await prisma.distributionAllocation.deleteMany({
      where: { allocationId: { in: temporaryAllocationIds } },
    });
  }
  if (temporaryDistributionIds.length > 0) {
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
  if (temporaryBarangayId) {
    await prisma.barangay.deleteMany({ where: { barangayId: temporaryBarangayId } });
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

  const suffix = Date.now().toString().slice(-10);
  const temporaryBarangay = await prisma.barangay.create({
    data: {
      barangayCode: `ALLOC-${suffix}`,
      barangayName: `Temporary Allocation Verification ${suffix}`,
      city: "Cebu City",
      province: "Cebu",
      isActive: true,
    },
    select: { barangayId: true },
  });
  temporaryBarangayId = temporaryBarangay.barangayId;

  const program = await prisma.program.create({
    data: {
      programName: `Temporary Allocation Program ${suffix}`,
      programCode: `ALOC-${suffix}`,
      programType: "CASH_ASSISTANCE",
      description: "Temporary record for Phase 3 verification.",
      grantAmount: 1000,
      budgetAmount: 2000,
      status: "ACTIVE",
      createdById: administrator.userId,
    },
  });
  temporaryProgramIds.push(program.programId);

  const beneficiaryInputs = [
    { firstName: "Alpha", status: "ACTIVE", enrollmentStatus: "APPROVED" },
    { firstName: "Bravo", status: "ACTIVE", enrollmentStatus: "APPROVED" },
    { firstName: "Charlie", status: "ACTIVE", enrollmentStatus: "APPROVED" },
    { firstName: "Pending", status: "ACTIVE", enrollmentStatus: "PENDING" },
    { firstName: "Inactive", status: "INACTIVE", enrollmentStatus: "APPROVED" },
  ];
  for (const [index, input] of beneficiaryInputs.entries()) {
    const beneficiary = await prisma.beneficiary.create({
      data: {
        firstName: input.firstName,
        lastName: `Allocation-${suffix}`,
        birthDate: new Date(`199${index}-01-01T00:00:00.000Z`),
        sex: index % 2 === 0 ? "MALE" : "FEMALE",
        address: "Temporary verification address",
        barangayId: facilitator.barangayId,
        status: input.status,
      },
    });
    temporaryBeneficiaryIds.push(beneficiary.beneficiaryId);
    const enrollment = await prisma.enrollment.create({
      data: {
        beneficiaryId: beneficiary.beneficiaryId,
        programId: program.programId,
        submittedById: facilitator.userId,
        status: input.enrollmentStatus,
        ...(input.enrollmentStatus === "APPROVED" ? {
          reviewedById: dswd.userId,
          reviewedAt: new Date(),
        } : {}),
      },
    });
    temporaryEnrollmentIds.push(enrollment.enrollmentId);
  }
  const [firstEnrollmentId, secondEnrollmentId, thirdEnrollmentId, pendingEnrollmentId,
    inactiveEnrollmentId] = temporaryEnrollmentIds;

  const downstreamCountsBefore = {
    schedules: await prisma.schedule.count(),
    qrTokens: await prisma.qrToken.count(),
    claims: await prisma.claim.count(),
    transactions: await prisma.transaction.count(),
  };
  const distributionDate = await unusedDistributionDate([
    facilitator.barangayId,
    temporaryBarangayId,
  ]);
  const [adminToken, dswdToken, facilitatorToken] = await Promise.all([
    verificationAccessToken(administrator),
    verificationAccessToken(dswd),
    verificationAccessToken(facilitator),
  ]);

  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  const distributionBody = {
    programId: program.programId,
    title: "Temporary Allocation Phase 3 Verification",
    distributionDate,
    startTime: "08:00",
    endTime: "10:00",
    slotDurationMinutes: 30,
    location: "Temporary Allocation Verification Hall",
    barangayId: facilitator.barangayId,
  };
  const createPrimary = await request("/distributions", {
    method: "POST",
    token: adminToken,
    body: distributionBody,
  });
  requireStatus(createPrimary, 201, "primary distribution creation");
  const distributionId = createPrimary.payload.data.distribution.distributionId;
  temporaryDistributionIds.push(distributionId);

  const createOtherBarangay = await request("/distributions", {
    method: "POST",
    token: adminToken,
    body: {
      ...distributionBody,
      title: "Temporary Cross-Barangay Allocation Verification",
      barangayId: temporaryBarangayId,
    },
  });
  requireStatus(createOtherBarangay, 201, "cross-Barangay distribution creation");
  const otherDistributionId = createOtherBarangay.payload.data.distribution.distributionId;
  temporaryDistributionIds.push(otherDistributionId);

  for (const [label, token] of [
    ["admin", adminToken],
    ["DSWD", dswdToken],
    ["assigned Barangay", facilitatorToken],
  ]) {
    const eligible = await request(
      `/distributions/${distributionId}/eligible-enrollments?search=Allocation&page=1&pageSize=10`,
      { token },
    );
    requireStatus(eligible, 200, `${label} eligible-enrollment read`);
    if (eligible.payload.data.pagination.total !== 3) {
      throw new Error(`${label} eligible-enrollment query did not return the three valid rows.`);
    }
  }

  const crossBarangayEligible = await request(
    `/distributions/${otherDistributionId}/eligible-enrollments`,
    { token: facilitatorToken },
  );
  requireStatus(crossBarangayEligible, 404, "cross-Barangay eligible-enrollment protection");

  const missingKey = await request(`/distributions/${distributionId}/allocations`, {
    method: "POST",
    token: adminToken,
    body: { enrollmentIds: [firstEnrollmentId] },
  });
  requireStatus(missingKey, 400, "required Idempotency-Key protection");
  requireErrorCode(missingKey, "IDEMPOTENCY_KEY_REQUIRED", "required Idempotency-Key protection");

  for (const [label, token] of [["DSWD", dswdToken], ["Barangay", facilitatorToken]]) {
    const forbidden = await request(`/distributions/${distributionId}/allocations`, {
      method: "POST",
      token,
      idempotencyKey: randomUUID(),
      body: { enrollmentIds: [firstEnrollmentId] },
    });
    requireStatus(forbidden, 403, `${label} allocation mutation RBAC`);
  }

  const pendingAttempt = await request(`/distributions/${distributionId}/allocations`, {
    method: "POST",
    token: adminToken,
    idempotencyKey: randomUUID(),
    body: { enrollmentIds: [pendingEnrollmentId] },
  });
  requireStatus(pendingAttempt, 409, "unapproved enrollment rejection");
  requireErrorCode(pendingAttempt, "ENROLLMENT_NOT_APPROVED", "unapproved enrollment rejection");

  const inactiveAttempt = await request(`/distributions/${distributionId}/allocations`, {
    method: "POST",
    token: adminToken,
    idempotencyKey: randomUUID(),
    body: { enrollmentIds: [inactiveEnrollmentId] },
  });
  requireStatus(inactiveAttempt, 409, "inactive beneficiary rejection");
  requireErrorCode(inactiveAttempt, "BENEFICIARY_NOT_ACTIVE", "inactive beneficiary rejection");

  const firstKey = randomUUID();
  const createFirstRequest = () => request(`/distributions/${distributionId}/allocations`, {
    method: "POST",
    token: adminToken,
    idempotencyKey: firstKey,
    body: { enrollmentIds: [firstEnrollmentId] },
  });
  const concurrentFirstResults = await Promise.all([
    createFirstRequest(),
    createFirstRequest(),
  ]);
  for (const [index, result] of concurrentFirstResults.entries()) {
    requireStatus(result, 201, `concurrent first allocation request ${index + 1}`);
  }
  const createFirst = concurrentFirstResults.find((result) => (
    result.response.headers.get("idempotency-replayed") === "false"
  ));
  const replayFirst = concurrentFirstResults.find((result) => (
    result.response.headers.get("idempotency-replayed") === "true"
  ));
  if (!createFirst || !replayFirst) {
    throw new Error("Concurrent idempotent requests did not produce one original and one replay.");
  }
  const firstAllocation = createFirst.payload.data.allocations[0];
  temporaryAllocationIds.push(firstAllocation.allocationId);
  if (
    firstAllocation.amount !== "1000"
    || firstAllocation.allocationStatus !== "ALLOCATED"
    || createFirst.response.headers.get("idempotency-replayed") !== "false"
  ) {
    throw new Error("First allocation did not derive the configured grant or idempotency state.");
  }

  if (
    replayFirst.payload.data.allocations[0].allocationId !== firstAllocation.allocationId
    || replayFirst.response.headers.get("idempotency-replayed") !== "true"
  ) {
    throw new Error("Idempotent replay did not return the original allocation response.");
  }

  const reusedKey = await request(`/distributions/${distributionId}/allocations`, {
    method: "POST",
    token: adminToken,
    idempotencyKey: firstKey,
    body: { enrollmentIds: [secondEnrollmentId] },
  });
  requireStatus(reusedKey, 409, "Idempotency-Key body mismatch");
  requireErrorCode(reusedKey, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key body mismatch");

  const duplicateAllocation = await request(`/distributions/${distributionId}/allocations`, {
    method: "POST",
    token: adminToken,
    idempotencyKey: randomUUID(),
    body: { enrollmentIds: [firstEnrollmentId] },
  });
  requireStatus(duplicateAllocation, 409, "duplicate allocation protection");
  requireErrorCode(
    duplicateAllocation,
    "DISTRIBUTION_ALLOCATION_ALREADY_EXISTS",
    "duplicate allocation protection",
  );

  const createSecond = await request(`/distributions/${distributionId}/allocations`, {
    method: "POST",
    token: adminToken,
    idempotencyKey: randomUUID(),
    body: { enrollmentIds: [secondEnrollmentId] },
  });
  requireStatus(createSecond, 201, "second allocation creation");
  temporaryAllocationIds.push(createSecond.payload.data.allocations[0].allocationId);

  const overBudget = await request(`/distributions/${distributionId}/allocations`, {
    method: "POST",
    token: adminToken,
    idempotencyKey: randomUUID(),
    body: { enrollmentIds: [thirdEnrollmentId] },
  });
  requireStatus(overBudget, 409, "program budget protection");
  requireErrorCode(overBudget, "PROGRAM_BUDGET_EXCEEDED", "program budget protection");

  for (const [label, token] of [
    ["admin", adminToken],
    ["DSWD", dswdToken],
    ["assigned Barangay", facilitatorToken],
  ]) {
    const list = await request(
      `/distributions/${distributionId}/allocations?status=ALLOCATED&search=Allocation&page=1&pageSize=1`,
      { token },
    );
    requireStatus(list, 200, `${label} allocation list`);
    if (
      list.payload.data.pagination.total !== 2
      || list.payload.data.allocations.length !== 1
      || list.payload.data.summary.countsByStatus.ALLOCATED !== 2
    ) {
      throw new Error(`${label} allocation filtering, pagination, or summary is incorrect.`);
    }
  }

  const crossBarangayList = await request(
    `/distributions/${otherDistributionId}/allocations`,
    { token: facilitatorToken },
  );
  requireStatus(crossBarangayList, 404, "cross-Barangay allocation list protection");

  const detail = await request(
    `/distributions/${distributionId}/allocations/${firstAllocation.allocationId}`,
    { token: dswdToken },
  );
  requireStatus(detail, 200, "DSWD allocation detail");
  const serializedDetail = JSON.stringify(detail.payload);
  for (const sensitiveField of ["address", "contactNumber", "email", "philsysNumber", "passwordHash", "totpSecret", "claim"]) {
    if (serializedDetail.includes(`\"${sensitiveField}\"`)) {
      throw new Error(`Allocation detail exposed sensitive or downstream field: ${sensitiveField}`);
    }
  }

  for (const [label, token] of [["DSWD", dswdToken], ["Barangay", facilitatorToken]]) {
    const forbiddenCancel = await request(
      `/distributions/${distributionId}/allocations/${firstAllocation.allocationId}/cancel`,
      { method: "POST", token },
    );
    requireStatus(forbiddenCancel, 403, `${label} allocation cancellation RBAC`);
  }

  const cancelFirst = await request(
    `/distributions/${distributionId}/allocations/${firstAllocation.allocationId}/cancel`,
    { method: "POST", token: adminToken },
  );
  requireStatus(cancelFirst, 200, "allocation cancellation");
  if (cancelFirst.payload.data.allocation.allocationStatus !== "CANCELLED") {
    throw new Error("Cancelled allocation did not return CANCELLED status.");
  }

  const createThird = await request(`/distributions/${distributionId}/allocations`, {
    method: "POST",
    token: adminToken,
    idempotencyKey: randomUUID(),
    body: { enrollmentIds: [thirdEnrollmentId] },
  });
  requireStatus(createThird, 201, "allocation after budget release");
  const thirdAllocationId = createThird.payload.data.allocations[0].allocationId;
  temporaryAllocationIds.push(thirdAllocationId);

  const overBudgetReactivation = await request(
    `/distributions/${distributionId}/allocations/${firstAllocation.allocationId}/reactivate`,
    { method: "POST", token: adminToken },
  );
  requireStatus(overBudgetReactivation, 409, "reactivation budget protection");
  requireErrorCode(
    overBudgetReactivation,
    "PROGRAM_BUDGET_EXCEEDED",
    "reactivation budget protection",
  );

  const cancelThird = await request(
    `/distributions/${distributionId}/allocations/${thirdAllocationId}/cancel`,
    { method: "POST", token: adminToken },
  );
  requireStatus(cancelThird, 200, "third allocation cancellation");

  const reactivateFirst = await request(
    `/distributions/${distributionId}/allocations/${firstAllocation.allocationId}/reactivate`,
    { method: "POST", token: adminToken },
  );
  requireStatus(reactivateFirst, 200, "allocation reactivation");
  if (reactivateFirst.payload.data.allocation.allocationStatus !== "ALLOCATED") {
    throw new Error("Reactivated allocation did not return ALLOCATED status.");
  }

  const lockedScope = await request(`/distributions/${distributionId}`, {
    method: "PATCH",
    token: adminToken,
    body: { barangayId: temporaryBarangayId },
  });
  requireStatus(lockedScope, 409, "allocation scope lock");
  requireErrorCode(lockedScope, "DISTRIBUTION_ALLOCATION_SCOPE_LOCKED", "allocation scope lock");

  const editableTitle = await request(`/distributions/${distributionId}`, {
    method: "PATCH",
    token: adminToken,
    body: { title: "Updated Temporary Allocation Verification" },
  });
  requireStatus(editableTitle, 200, "non-scope distribution edit after allocation");

  const requiredActions = [
    "DISTRIBUTION_ALLOCATION_CREATED",
    "DISTRIBUTION_ALLOCATION_CANCELLED",
    "DISTRIBUTION_ALLOCATION_REACTIVATED",
  ];
  const auditActions = await prisma.auditLog.findMany({
    where: {
      recordId: { in: temporaryAllocationIds },
      action: { in: requiredActions },
    },
    select: { action: true },
  });
  const actions = new Set(auditActions.map((entry) => entry.action));
  for (const action of requiredActions) {
    if (!actions.has(action)) {
      throw new Error(`Missing distribution-allocation audit action: ${action}`);
    }
  }

  const cancelDistribution = await request(`/distributions/${distributionId}/cancel`, {
    method: "POST",
    token: adminToken,
  });
  requireStatus(cancelDistribution, 200, "distribution cancellation with allocations");
  const nonCancelledAllocationCount = await prisma.distributionAllocation.count({
    where: {
      distributionId,
      allocationStatus: { not: "CANCELLED" },
    },
  });
  if (nonCancelledAllocationCount !== 0) {
    throw new Error("Cancelling the event did not cancel every unclaimed allocation.");
  }

  const cancelledEventMutation = await request(
    `/distributions/${distributionId}/allocations/${firstAllocation.allocationId}/reactivate`,
    { method: "POST", token: adminToken },
  );
  requireStatus(cancelledEventMutation, 409, "cancelled-event allocation mutation lock");

  const downstreamCountsAfter = {
    schedules: await prisma.schedule.count(),
    qrTokens: await prisma.qrToken.count(),
    claims: await prisma.claim.count(),
    transactions: await prisma.transaction.count(),
  };
  if (JSON.stringify(downstreamCountsAfter) !== JSON.stringify(downstreamCountsBefore)) {
    throw new Error("Allocation Phase 3 changed schedule, QR-token, claim, or transaction records.");
  }

  console.log("Distribution Allocation Management Phase 3 HTTP workflow verification passed.");
} finally {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await cleanup();
  await prisma.$disconnect();
}
