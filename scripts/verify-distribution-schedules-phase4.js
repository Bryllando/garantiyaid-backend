import { randomUUID } from "node:crypto";
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

async function unusedDistributionDate(barangayId) {
  for (let offsetDays = 1200; offsetDays <= 1500; offsetDays += 1) {
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
  throw new Error("Could not find an unused future date for Phase 4 verification.");
}

async function cleanup() {
  if (temporaryDistributionIds.length > 0) {
    await prisma.idempotencyRecord.deleteMany({
      where: {
        operation: {
          in: temporaryDistributionIds.flatMap((id) => [
            `DISTRIBUTION_ALLOCATION_BATCH:${id}`,
            `DISTRIBUTION_SCHEDULE_BATCH:${id}`,
          ]),
        },
      },
    });
  }
  const auditRecordIds = [
    ...temporaryDistributionIds,
    ...temporaryAllocationIds,
    ...temporaryScheduleIds,
  ];
  if (auditRecordIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { recordId: { in: auditRecordIds } } });
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
      programName: `Temporary Scheduling Program ${suffix}`,
      programCode: `SCH-${suffix}`,
      programType: "CASH_ASSISTANCE",
      description: "Temporary record for Phase 4 verification.",
      grantAmount: 1000,
      budgetAmount: 10000,
      status: "ACTIVE",
      createdById: administrator.userId,
    },
  });
  temporaryProgramIds.push(program.programId);

  const beneficiaries = [];
  for (const [index, firstName] of ["Alpha", "Bravo", "Charlie", "Delta"].entries()) {
    const beneficiary = await prisma.beneficiary.create({
      data: {
        firstName,
        lastName: `PhaseFour${suffix}`,
        birthDate: new Date(`199${index}-01-01T00:00:00.000Z`),
        sex: index % 2 === 0 ? "FEMALE" : "MALE",
        address: "Temporary verification address",
        barangayId: facilitator.barangayId,
        isVerified: true,
        status: "ACTIVE",
      },
    });
    temporaryBeneficiaryIds.push(beneficiary.beneficiaryId);
    beneficiaries.push(beneficiary);
  }

  const enrollmentIds = [];
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
    enrollmentIds.push(enrollment.enrollmentId);
  }

  const eventDate = await unusedDistributionDate(facilitator.barangayId);
  const createdEvent = await request("/distributions", {
    method: "POST",
    token: adminToken,
    body: {
      programId: program.programId,
      title: `Temporary Phase 4 Event ${suffix}`,
      distributionDate: eventDate,
      startTime: "08:00",
      endTime: "09:00",
      slotDurationMinutes: 30,
      location: "Temporary Verification Hall",
      barangayId: facilitator.barangayId,
    },
  });
  requireStatus(createdEvent, 201, "event creation");
  const distributionId = createdEvent.payload.data.distribution.distributionId;
  temporaryDistributionIds.push(distributionId);

  const generatedSlots = await request(`/distributions/${distributionId}/slots/generate`, {
    method: "POST",
    token: adminToken,
    body: { capacity: 2 },
  });
  requireStatus(generatedSlots, 201, "slot generation");
  const [firstSlot, secondSlot] = generatedSlots.payload.data.slots;
  if (!firstSlot || !secondSlot) {
    throw new Error("Phase 4 verification requires exactly two generated slots.");
  }

  const createdAllocations = await request(`/distributions/${distributionId}/allocations`, {
    method: "POST",
    token: adminToken,
    idempotencyKey: randomUUID(),
    body: { enrollmentIds },
  });
  requireStatus(createdAllocations, 201, "allocation creation");
  const allocations = createdAllocations.payload.data.allocations;
  temporaryAllocationIds.push(...allocations.map((row) => row.allocationId));

  const schedulable = await request(
    `/distributions/${distributionId}/schedulable-allocations?page=1&pageSize=20`,
    { token: facilitatorToken },
  );
  requireStatus(schedulable, 200, "facilitator-scoped schedulable allocation list");
  if (schedulable.payload.data.summary.schedulableAllocationCount !== 4) {
    throw new Error("Schedulable allocation list did not return all four allocations.");
  }

  const forbiddenManual = await request(`/distributions/${distributionId}/schedules`, {
    method: "POST",
    token: dswdToken,
    body: { allocationId: allocations[0].allocationId, slotId: firstSlot.slotId },
  });
  requireStatus(forbiddenManual, 403, "DSWD schedule mutation protection");
  requireErrorCode(forbiddenManual, "FORBIDDEN", "DSWD schedule mutation protection");

  const manual = await request(`/distributions/${distributionId}/schedules`, {
    method: "POST",
    token: adminToken,
    body: { allocationId: allocations[0].allocationId, slotId: firstSlot.slotId },
  });
  requireStatus(manual, 201, "manual schedule assignment");
  const manualSchedule = manual.payload.data.schedule;
  temporaryScheduleIds.push(manualSchedule.scheduleId);
  if (manualSchedule.queueNumber !== 1 || manualSchedule.assignedByAi !== false) {
    throw new Error("Manual schedule did not receive queue 1 with assignedByAi=false.");
  }

  const generationKey = randomUUID();
  const generationBody = {
    allocationIds: [allocations[1].allocationId, allocations[2].allocationId],
  };
  const generated = await request(`/distributions/${distributionId}/schedules/generate`, {
    method: "POST",
    token: adminToken,
    idempotencyKey: generationKey,
    body: generationBody,
  });
  requireStatus(generated, 201, "automatic schedule generation");
  temporaryScheduleIds.push(...generated.payload.data.schedules.map((row) => row.scheduleId));
  if (generated.response.headers.get("idempotency-replayed") !== "false") {
    throw new Error("First generation request was not marked Idempotency-Replayed=false.");
  }

  const replay = await request(`/distributions/${distributionId}/schedules/generate`, {
    method: "POST",
    token: adminToken,
    idempotencyKey: generationKey,
    body: generationBody,
  });
  requireStatus(replay, 201, "schedule generation idempotent replay");
  const generatedScheduleIds = generated.payload.data.schedules
    .map((row) => row.scheduleId)
    .sort();
  const replayedScheduleIds = replay.payload.data.schedules
    .map((row) => row.scheduleId)
    .sort();
  if (
    replay.response.headers.get("idempotency-replayed") !== "true"
    || JSON.stringify(replayedScheduleIds) !== JSON.stringify(generatedScheduleIds)
  ) {
    throw new Error("Schedule generation replay did not return the original response.");
  }

  const reusedKey = await request(`/distributions/${distributionId}/schedules/generate`, {
    method: "POST",
    token: adminToken,
    idempotencyKey: generationKey,
    body: { allocationIds: [allocations[1].allocationId] },
  });
  requireStatus(reusedKey, 409, "schedule-generation Idempotency-Key mismatch");
  requireErrorCode(reusedKey, "IDEMPOTENCY_KEY_REUSED", "schedule-generation key mismatch");

  const fullSlotAttempt = await request(`/distributions/${distributionId}/schedules`, {
    method: "POST",
    token: adminToken,
    body: { allocationId: allocations[3].allocationId, slotId: firstSlot.slotId },
  });
  requireStatus(fullSlotAttempt, 409, "full-slot capacity protection");
  if (![
    "DISTRIBUTION_SLOT_NOT_AVAILABLE",
    "DISTRIBUTION_SLOT_CAPACITY_EXCEEDED",
  ].includes(fullSlotAttempt.payload.error?.code)) {
    throw new Error(`Unexpected full-slot error: ${JSON.stringify(fullSlotAttempt.payload)}`);
  }

  const rescheduled = await request(
    `/distributions/${distributionId}/schedules/${manualSchedule.scheduleId}/reschedule`,
    {
      method: "POST",
      token: adminToken,
      body: { slotId: secondSlot.slotId },
    },
  );
  requireStatus(rescheduled, 200, "schedule rescheduling");
  if (rescheduled.payload.data.schedule.queueNumber !== 2) {
    throw new Error("Rescheduled beneficiary did not receive the next queue number in the slot.");
  }

  const cancelled = await request(
    `/distributions/${distributionId}/schedules/${manualSchedule.scheduleId}/cancel`,
    { method: "POST", token: adminToken },
  );
  requireStatus(cancelled, 200, "schedule cancellation");
  if (cancelled.payload.data.schedule.status !== "CANCELLED") {
    throw new Error("Schedule cancellation did not set CANCELLED status.");
  }

  const openWhileCancelled = await request(`/distributions/${distributionId}/open`, {
    method: "POST",
    token: adminToken,
  });
  requireStatus(openWhileCancelled, 409, "opening readiness validation");
  requireErrorCode(
    openWhileCancelled,
    "DISTRIBUTION_ALLOCATIONS_UNSCHEDULED",
    "opening readiness validation",
  );

  const reactivated = await request(
    `/distributions/${distributionId}/schedules/${manualSchedule.scheduleId}/reactivate`,
    { method: "POST", token: adminToken },
  );
  requireStatus(reactivated, 200, "schedule reactivation");

  const fourth = await request(`/distributions/${distributionId}/schedules`, {
    method: "POST",
    token: adminToken,
    body: { allocationId: allocations[3].allocationId, slotId: firstSlot.slotId },
  });
  requireStatus(fourth, 201, "final manual schedule assignment");
  temporaryScheduleIds.push(fourth.payload.data.schedule.scheduleId);
  if (fourth.payload.data.schedule.queueNumber !== 3) {
    throw new Error("Queue numbers were reused after rescheduling; expected queue number 3.");
  }

  const listed = await request(
    `/distributions/${distributionId}/schedules?status=SCHEDULED&search=${beneficiaries[0].firstName}`,
    { token: dswdToken },
  );
  requireStatus(listed, 200, "DSWD schedule monitoring");
  const serializedList = JSON.stringify(listed.payload);
  for (const forbiddenField of ["address", "contactNumber", "email", "philsysNumber", "passwordHash"] ) {
    if (serializedList.includes(`\"${forbiddenField}\"`)) {
      throw new Error(`Schedule response exposed sensitive field ${forbiddenField}.`);
    }
  }

  const forbiddenOpen = await request(`/distributions/${distributionId}/open`, {
    method: "POST",
    token: dswdToken,
  });
  requireStatus(forbiddenOpen, 403, "DSWD open-event protection");

  const opened = await request(`/distributions/${distributionId}/open`, {
    method: "POST",
    token: adminToken,
  });
  requireStatus(opened, 200, "distribution open transition");
  if (opened.payload.data.distribution.status !== "OPEN") {
    throw new Error("Distribution did not transition from DRAFT to OPEN.");
  }

  const frozen = await request(
    `/distributions/${distributionId}/schedules/${manualSchedule.scheduleId}/reschedule`,
    {
      method: "POST",
      token: adminToken,
      body: { slotId: firstSlot.slotId },
    },
  );
  requireStatus(frozen, 409, "open-event schedule freeze");
  requireErrorCode(frozen, "DISTRIBUTION_SCHEDULES_NOT_EDITABLE", "open-event freeze");

  const queueGroups = await prisma.schedule.groupBy({
    by: ["slotId", "queueNumber"],
    where: { distributionId },
    _count: { _all: true },
  });
  if (queueGroups.some((group) => group._count._all !== 1)) {
    throw new Error("Queue number uniqueness was violated inside a slot.");
  }
  const auditActions = await prisma.auditLog.findMany({
    where: { recordId: { in: temporaryScheduleIds } },
    select: { action: true },
  });
  const actionSet = new Set(auditActions.map((row) => row.action));
  for (const action of [
    "DISTRIBUTION_SCHEDULE_CREATED",
    "DISTRIBUTION_SCHEDULE_GENERATED",
    "DISTRIBUTION_SCHEDULE_RESCHEDULED",
    "DISTRIBUTION_SCHEDULE_CANCELLED",
    "DISTRIBUTION_SCHEDULE_REACTIVATED",
  ]) {
    if (!actionSet.has(action)) {
      throw new Error(`Required audit action ${action} was not recorded.`);
    }
  }

  console.log("Phase 4 distribution scheduling verification passed.");
  console.log("Verified manual and automatic assignment, safe queue numbers, capacity limits,");
  console.log("idempotent replay, reschedule/cancel/reactivate, scoped reads, privacy, audits,");
  console.log("readiness validation, DRAFT -> OPEN, and post-open mutation freezing.");
} finally {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await cleanup();
  await prisma.$disconnect();
}
