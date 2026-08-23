import { once } from "node:events";
import app from "../src/app.js";
import prisma from "../src/lib/prisma.js";
import { issueAccessToken } from "../src/modules/auth/auth.service.js";

let server;
let baseUrl;
let temporaryBarangayId;
const temporaryDistributionIds = [];
const temporarySlotIds = [];
const temporarySessionIds = [];

async function verificationAccessToken(user) {
  const session = await issueAccessToken(user, { ipAddress: "127.0.0.1" });
  temporarySessionIds.push(session.sessionId);
  return session.accessToken;
}

async function request(path, { method = "GET", token, body } = {}) {
  const hasJsonBody = body !== undefined;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(hasJsonBody ? { "content-type": "application/json" } : {}),
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

function futureDate(offsetDays) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

async function unusedDistributionDate(barangayIds) {
  for (let offsetDays = 500; offsetDays <= 800; offsetDays += 1) {
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

  throw new Error("Could not find an unused future distribution date for slot verification.");
}

async function cleanup() {
  const recordIds = [...temporaryDistributionIds, ...temporarySlotIds];
  if (recordIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { recordId: { in: recordIds } } });
  }
  if (temporarySlotIds.length > 0) {
    await prisma.distributionSlot.deleteMany({
      where: { slotId: { in: temporarySlotIds } },
    });
  }
  if (temporaryDistributionIds.length > 0) {
    await prisma.distribution.deleteMany({
      where: { distributionId: { in: temporaryDistributionIds } },
    });
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
  const [administrator, dswd, facilitator, program] = await Promise.all([
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
    prisma.program.findFirst({ where: { status: "ACTIVE" } }),
  ]);

  if (!administrator || !dswd || !facilitator || !program) {
    throw new Error(
      "Active SYSTEM_ADMIN, DSWD_STAFF, assigned BARANGAY_FACILITATOR, and ACTIVE program are required.",
    );
  }

  const relatedCountsBefore = {
    allocations: await prisma.distributionAllocation.count(),
    schedules: await prisma.schedule.count(),
    qrTokens: await prisma.qrToken.count(),
    claims: await prisma.claim.count(),
  };

  const suffix = Date.now().toString().slice(-10);
  const temporaryBarangay = await prisma.barangay.create({
    data: {
      barangayCode: `SLOT-${suffix}`,
      barangayName: `Temporary Slot Verification ${suffix}`,
      city: "Cebu City",
      province: "Cebu",
      isActive: true,
    },
    select: { barangayId: true },
  });
  temporaryBarangayId = temporaryBarangay.barangayId;

  const distributionDate = await unusedDistributionDate([
    facilitator.barangayId,
    temporaryBarangayId,
  ]);
  const adminToken = await verificationAccessToken(administrator);
  const dswdToken = await verificationAccessToken(dswd);
  const facilitatorToken = await verificationAccessToken(facilitator);

  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  const primaryInput = {
    programId: program.programId,
    title: "Temporary Slot Phase 2 Verification",
    distributionDate,
    startTime: "08:00",
    endTime: "10:00",
    slotDurationMinutes: 30,
    location: "Temporary Slot Verification Hall",
    barangayId: facilitator.barangayId,
  };
  const createPrimary = await request("/distributions", {
    method: "POST",
    token: adminToken,
    body: primaryInput,
  });
  requireStatus(createPrimary, 201, "slot-verification distribution creation");
  const primaryId = createPrimary.payload.data.distribution.distributionId;
  temporaryDistributionIds.push(primaryId);

  const createOtherBarangay = await request("/distributions", {
    method: "POST",
    token: adminToken,
    body: {
      ...primaryInput,
      title: "Temporary Cross-Barangay Slot Verification",
      barangayId: temporaryBarangayId,
    },
  });
  requireStatus(createOtherBarangay, 201, "cross-Barangay distribution creation");
  const otherDistributionId = createOtherBarangay.payload.data.distribution.distributionId;
  temporaryDistributionIds.push(otherDistributionId);

  for (const [label, token] of [
    ["DSWD", dswdToken],
    ["Barangay", facilitatorToken],
  ]) {
    const forbiddenGenerate = await request(`/distributions/${primaryId}/slots/generate`, {
      method: "POST",
      token,
      body: { capacity: 30 },
    });
    requireStatus(forbiddenGenerate, 403, `${label} slot-generation RBAC check`);
  }

  const generate = await request(`/distributions/${primaryId}/slots/generate`, {
    method: "POST",
    token: adminToken,
    body: { capacity: 30 },
  });
  requireStatus(generate, 201, "admin slot generation");
  const slots = generate.payload.data.slots;
  if (
    slots.length !== 4
    || generate.payload.data.summary.totalCapacity !== 120
    || slots[0].slotStart !== `${distributionDate}T08:00:00+08:00`
    || slots[3].slotEnd !== `${distributionDate}T10:00:00+08:00`
  ) {
    throw new Error("Generated slot intervals, capacity, or Philippine timestamps are incorrect.");
  }
  temporarySlotIds.push(...slots.map((slot) => slot.slotId));
  const firstSlotId = slots[0].slotId;

  const duplicateGenerate = await request(`/distributions/${primaryId}/slots/generate`, {
    method: "POST",
    token: adminToken,
    body: { capacity: 30 },
  });
  requireStatus(duplicateGenerate, 409, "duplicate slot generation protection");

  for (const [label, token] of [
    ["admin", adminToken],
    ["DSWD", dswdToken],
    ["assigned Barangay", facilitatorToken],
  ]) {
    const list = await request(
      `/distributions/${primaryId}/slots?slotStatus=AVAILABLE&page=1&pageSize=2`,
      { token },
    );
    requireStatus(list, 200, `${label} scoped slot list`);
    if (list.payload.data.pagination.total !== 4 || list.payload.data.slots.length !== 2) {
      throw new Error(`${label} slot filtering or pagination is incorrect.`);
    }
  }

  const crossBarangayRead = await request(
    `/distributions/${otherDistributionId}/slots`,
    { token: facilitatorToken },
  );
  requireStatus(crossBarangayRead, 404, "cross-Barangay slot read protection");

  const slotDetail = await request(
    `/distributions/${primaryId}/slots/${firstSlotId}`,
    { token: dswdToken },
  );
  requireStatus(slotDetail, 200, "DSWD slot detail read");

  for (const [label, token] of [
    ["DSWD", dswdToken],
    ["Barangay", facilitatorToken],
  ]) {
    const forbiddenCapacity = await request(
      `/distributions/${primaryId}/slots/${firstSlotId}`,
      { method: "PATCH", token, body: { capacity: 40 } },
    );
    requireStatus(forbiddenCapacity, 403, `${label} slot-capacity RBAC check`);
  }

  const updateCapacity = await request(
    `/distributions/${primaryId}/slots/${firstSlotId}`,
    { method: "PATCH", token: adminToken, body: { capacity: 40 } },
  );
  requireStatus(updateCapacity, 200, "admin slot capacity update");
  if (updateCapacity.payload.data.slot.capacity !== 40) {
    throw new Error("Updated slot capacity was not returned.");
  }

  const close = await request(
    `/distributions/${primaryId}/slots/${firstSlotId}/close`,
    { method: "POST", token: adminToken },
  );
  requireStatus(close, 200, "slot close");
  if (close.payload.data.slot.slotStatus !== "CLOSED") {
    throw new Error("Closed slot did not return CLOSED status.");
  }

  const duplicateClose = await request(
    `/distributions/${primaryId}/slots/${firstSlotId}/close`,
    { method: "POST", token: adminToken },
  );
  requireStatus(duplicateClose, 409, "duplicate slot close transition protection");

  const reopen = await request(
    `/distributions/${primaryId}/slots/${firstSlotId}/reopen`,
    { method: "POST", token: adminToken },
  );
  requireStatus(reopen, 200, "slot reopen");
  if (reopen.payload.data.slot.slotStatus !== "AVAILABLE") {
    throw new Error("Reopened slot did not return AVAILABLE status.");
  }

  const lockedSchedule = await request(`/distributions/${primaryId}`, {
    method: "PATCH",
    token: adminToken,
    body: { startTime: "09:00" },
  });
  requireStatus(lockedSchedule, 409, "generated-slot schedule lock");
  if (lockedSchedule.payload.error.code !== "DISTRIBUTION_SCHEDULE_LOCKED") {
    throw new Error("Schedule lock returned the wrong error code.");
  }

  const editableTitle = await request(`/distributions/${primaryId}`, {
    method: "PATCH",
    token: adminToken,
    body: { title: "Updated Temporary Slot Verification" },
  });
  requireStatus(editableTitle, 200, "non-schedule distribution update after generation");

  const unsupportedDelete = await request(
    `/distributions/${primaryId}/slots/${firstSlotId}`,
    { method: "DELETE", token: adminToken },
  );
  requireStatus(unsupportedDelete, 404, "slot deletion route absence");

  const requiredActions = [
    "DISTRIBUTION_SLOTS_GENERATED",
    "DISTRIBUTION_SLOT_CAPACITY_UPDATED",
    "DISTRIBUTION_SLOT_CLOSED",
    "DISTRIBUTION_SLOT_REOPENED",
  ];
  const auditActions = await prisma.auditLog.findMany({
    where: {
      action: { in: requiredActions },
      OR: [
        { recordId: primaryId },
        { recordId: { in: temporarySlotIds } },
      ],
    },
    select: { action: true },
  });
  const actions = new Set(auditActions.map((entry) => entry.action));
  for (const action of requiredActions) {
    if (!actions.has(action)) {
      throw new Error(`Missing distribution-slot audit action: ${action}`);
    }
  }

  const cancel = await request(`/distributions/${primaryId}/cancel`, {
    method: "POST",
    token: adminToken,
  });
  requireStatus(cancel, 200, "distribution cancellation with slots");
  const closedCount = await prisma.distributionSlot.count({
    where: { distributionId: primaryId, slotStatus: "CLOSED" },
  });
  if (closedCount !== 4) {
    throw new Error("Cancelling the event did not close all generated slots.");
  }

  const cancelledSlotUpdate = await request(
    `/distributions/${primaryId}/slots/${firstSlotId}`,
    { method: "PATCH", token: adminToken, body: { capacity: 50 } },
  );
  requireStatus(cancelledSlotUpdate, 409, "cancelled-event slot edit lock");

  const relatedCountsAfter = {
    allocations: await prisma.distributionAllocation.count(),
    schedules: await prisma.schedule.count(),
    qrTokens: await prisma.qrToken.count(),
    claims: await prisma.claim.count(),
  };
  if (JSON.stringify(relatedCountsAfter) !== JSON.stringify(relatedCountsBefore)) {
    throw new Error("Slot Phase 2 changed allocation, schedule, QR-token, or claim records.");
  }

  console.log("Distribution Slots Phase 2 HTTP workflow verification passed.");
} finally {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await cleanup();
  await prisma.$disconnect();
}
