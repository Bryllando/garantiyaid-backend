import { once } from "node:events";
import app from "../src/app.js";
import prisma from "../src/lib/prisma.js";
import { issueAccessToken } from "../src/modules/auth/auth.service.js";

let server;
let baseUrl;
let temporaryBarangayId;
const temporaryDistributionIds = [];
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

async function unusedDistributionDate(barangayId) {
  for (let offsetDays = 90; offsetDays <= 450; offsetDays += 1) {
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

  throw new Error("Could not find an unused future distribution date for verification.");
}

async function cleanup() {
  if (temporarySessionIds.length > 0) {
    await prisma.staffSession.deleteMany({
      where: { sessionId: { in: temporarySessionIds } },
    });
  }
  if (temporaryDistributionIds.length > 0) {
    await prisma.auditLog.deleteMany({
      where: { recordId: { in: temporaryDistributionIds } },
    });
    await prisma.distribution.deleteMany({
      where: { distributionId: { in: temporaryDistributionIds } },
    });
  }

  if (temporaryBarangayId) {
    await prisma.barangay.deleteMany({
      where: { barangayId: temporaryBarangayId },
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
    slots: await prisma.distributionSlot.count(),
    allocations: await prisma.distributionAllocation.count(),
  };

  const suffix = Date.now().toString().slice(-10);
  const temporaryBarangay = await prisma.barangay.create({
    data: {
      barangayCode: `TMP-${suffix}`,
      barangayName: `Temporary Distribution Verification ${suffix}`,
      city: "Cebu City",
      province: "Cebu",
      isActive: true,
    },
    select: { barangayId: true },
  });
  temporaryBarangayId = temporaryBarangay.barangayId;

  const distributionDate = await unusedDistributionDate(facilitator.barangayId);
  const adminToken = await verificationAccessToken(administrator);
  const dswdToken = await verificationAccessToken(dswd);
  const facilitatorToken = await verificationAccessToken(facilitator);

  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  const primaryInput = {
    programId: program.programId,
    title: "Temporary Distribution Verification",
    distributionDate,
    startTime: "08:00",
    endTime: "10:00",
    slotDurationMinutes: 30,
    location: "Temporary Verification Hall",
    barangayId: facilitator.barangayId,
  };

  const forbiddenDswdCreate = await request("/distributions", {
    method: "POST",
    token: dswdToken,
    body: primaryInput,
  });
  requireStatus(forbiddenDswdCreate, 403, "DSWD distribution creation RBAC check");

  const forbiddenFacilitatorCreate = await request("/distributions", {
    method: "POST",
    token: facilitatorToken,
    body: primaryInput,
  });
  requireStatus(
    forbiddenFacilitatorCreate,
    403,
    "BARANGAY_FACILITATOR distribution creation RBAC check",
  );

  const createPrimary = await request("/distributions", {
    method: "POST",
    token: adminToken,
    body: primaryInput,
  });
  requireStatus(createPrimary, 201, "SYSTEM_ADMIN distribution creation");
  const primaryId = createPrimary.payload.data.distribution.distributionId;
  temporaryDistributionIds.push(primaryId);
  if (
    createPrimary.payload.data.distribution.status !== "DRAFT"
    || createPrimary.payload.data.distribution.startTime !== "08:00"
    || createPrimary.payload.data.distribution.endTime !== "10:00"
  ) {
    throw new Error("New distribution event did not return the expected DRAFT/time values.");
  }

  const overlapAttempt = await request("/distributions", {
    method: "POST",
    token: adminToken,
    body: {
      ...primaryInput,
      title: "Forbidden Overlap",
      startTime: "09:30",
      endTime: "10:30",
    },
  });
  requireStatus(overlapAttempt, 409, "same-barangay overlapping event check");
  if (overlapAttempt.payload.error.code !== "DISTRIBUTION_TIME_CONFLICT") {
    throw new Error("Overlapping distribution returned the wrong error code.");
  }

  const createAdjacent = await request("/distributions", {
    method: "POST",
    token: adminToken,
    body: {
      ...primaryInput,
      title: "Temporary Adjacent Event",
      startTime: "10:00",
      endTime: "11:00",
    },
  });
  requireStatus(createAdjacent, 201, "adjacent non-overlapping event creation");
  const adjacentId = createAdjacent.payload.data.distribution.distributionId;
  temporaryDistributionIds.push(adjacentId);

  const createOtherBarangay = await request("/distributions", {
    method: "POST",
    token: adminToken,
    body: {
      ...primaryInput,
      title: "Temporary Other Barangay Event",
      barangayId: temporaryBarangayId,
      startTime: "13:00",
      endTime: "14:00",
    },
  });
  requireStatus(createOtherBarangay, 201, "other-barangay distribution creation");
  const otherBarangayDistributionId = createOtherBarangay.payload.data.distribution.distributionId;
  temporaryDistributionIds.push(otherBarangayDistributionId);

  const dswdQuery = new URLSearchParams({
    programId: program.programId,
    barangayId: facilitator.barangayId,
    status: "DRAFT",
    dateFrom: distributionDate,
    dateTo: distributionDate,
    page: "1",
    pageSize: "1",
  });
  const dswdFilteredList = await request(`/distributions?${dswdQuery}`, {
    token: dswdToken,
  });
  requireStatus(dswdFilteredList, 200, "DSWD filtered/paginated global event read");
  if (
    dswdFilteredList.payload.data.distributions.length !== 1
    || dswdFilteredList.payload.data.pagination.pageSize !== 1
    || dswdFilteredList.payload.data.pagination.total < 2
  ) {
    throw new Error("Distribution filters or pagination returned unexpected results.");
  }

  const facilitatorList = await request("/distributions?page=1&pageSize=100", {
    token: facilitatorToken,
  });
  requireStatus(facilitatorList, 200, "facilitator assigned-barangay event list");
  if (
    facilitatorList.payload.data.distributions.some(
      (distribution) => distribution.barangayId !== facilitator.barangayId,
    )
  ) {
    throw new Error("Facilitator list exposed a distribution from another barangay.");
  }

  const forbiddenBarangayFilter = await request(
    `/distributions?barangayId=${temporaryBarangayId}`,
    { token: facilitatorToken },
  );
  requireStatus(forbiddenBarangayFilter, 403, "facilitator cross-barangay filter check");

  const hiddenOtherBarangayDetail = await request(
    `/distributions/${otherBarangayDistributionId}`,
    { token: facilitatorToken },
  );
  requireStatus(hiddenOtherBarangayDetail, 404, "facilitator cross-barangay detail check");

  const dswdOtherBarangayDetail = await request(
    `/distributions/${otherBarangayDistributionId}`,
    { token: dswdToken },
  );
  requireStatus(dswdOtherBarangayDetail, 200, "DSWD global distribution detail read");

  const forbiddenDswdUpdate = await request(`/distributions/${primaryId}`, {
    method: "PATCH",
    token: dswdToken,
    body: { title: "Forbidden DSWD Update" },
  });
  requireStatus(forbiddenDswdUpdate, 403, "DSWD distribution update RBAC check");

  const conflictingUpdate = await request(`/distributions/${adjacentId}`, {
    method: "PATCH",
    token: adminToken,
    body: { startTime: "09:30" },
  });
  requireStatus(conflictingUpdate, 409, "overlapping distribution update check");

  const updatePrimary = await request(`/distributions/${primaryId}`, {
    method: "PATCH",
    token: adminToken,
    body: {
      title: "Updated Temporary Distribution Verification",
      location: "Updated Temporary Verification Hall",
    },
  });
  requireStatus(updatePrimary, 200, "SYSTEM_ADMIN draft distribution update");

  const cancelPrimary = await request(`/distributions/${primaryId}/cancel`, {
    method: "POST",
    token: adminToken,
  });
  requireStatus(cancelPrimary, 200, "SYSTEM_ADMIN draft distribution cancellation");
  if (cancelPrimary.payload.data.distribution.status !== "CANCELLED") {
    throw new Error("Cancelled distribution did not return CANCELLED status.");
  }

  const cancelledUpdate = await request(`/distributions/${primaryId}`, {
    method: "PATCH",
    token: adminToken,
    body: { title: "Must Not Be Updated" },
  });
  requireStatus(cancelledUpdate, 409, "cancelled distribution edit lock");

  const replacementAfterCancellation = await request("/distributions", {
    method: "POST",
    token: adminToken,
    body: {
      ...primaryInput,
      title: "Temporary Replacement After Cancellation",
    },
  });
  requireStatus(
    replacementAfterCancellation,
    201,
    "cancelled event exclusion from overlap checks",
  );
  const replacementId = replacementAfterCancellation.payload.data.distribution.distributionId;
  temporaryDistributionIds.push(replacementId);

  const unsupportedDelete = await request(`/distributions/${replacementId}`, {
    method: "DELETE",
    token: adminToken,
  });
  requireStatus(unsupportedDelete, 404, "distribution delete route absence");

  const unsupportedSlots = await request(`/distributions/${replacementId}/slots`, {
    method: "POST",
    token: adminToken,
    body: {},
  });
  requireStatus(unsupportedSlots, 404, "distribution slots route absence");

  const auditActions = await prisma.auditLog.findMany({
    where: { recordId: primaryId },
    select: { action: true },
  });
  const actions = new Set(auditActions.map((entry) => entry.action));
  for (const action of [
    "DISTRIBUTION_CREATED",
    "DISTRIBUTION_UPDATED",
    "DISTRIBUTION_CANCELLED",
  ]) {
    if (!actions.has(action)) {
      throw new Error(`Missing distribution audit action: ${action}`);
    }
  }

  const auditApiRead = await request(
    `/audit-logs?entityAffected=DISTRIBUTION&recordId=${primaryId}&page=1&pageSize=20`,
    { token: dswdToken },
  );
  requireStatus(auditApiRead, 200, "distribution audit-log API visibility");
  if (auditApiRead.payload.data.pagination.total < 3) {
    throw new Error("Distribution audit actions were not visible through the audit API.");
  }

  const relatedCountsAfter = {
    slots: await prisma.distributionSlot.count(),
    allocations: await prisma.distributionAllocation.count(),
  };
  if (JSON.stringify(relatedCountsAfter) !== JSON.stringify(relatedCountsBefore)) {
    throw new Error("Distribution verification changed slot or allocation records.");
  }

  console.log("Distribution event management HTTP workflow verification passed.");
} finally {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await cleanup();
  await prisma.$disconnect();
}
