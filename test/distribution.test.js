import test from "node:test";
import assert from "node:assert/strict";
import distributionRoutes from "../src/modules/distributions/distribution.routes.js";
import {
  DISTRIBUTION_MANAGE_ROLES,
  DISTRIBUTION_READ_ROLES,
  assertDistributionManageAllowed,
  assertDistributionReadAllowed,
  distributionAccessWhere,
  resolveDistributionListBarangay,
} from "../src/modules/distributions/distribution.policy.js";
import {
  createDistributionSchema,
  distributionListQuerySchema,
  updateDistributionSchema,
} from "../src/modules/distributions/distribution.schemas.js";
import {
  assertDistributionConfigurationValid,
  assertDistributionDraft,
  assertDistributionTransition,
  assertActiveDistributionBarangay,
  assertActiveDistributionProgram,
  assertNoDistributionOverlap,
  buildDistributionOverlapWhere,
  distributionSelect,
  distributionToResponse,
} from "../src/modules/distributions/distribution.service.js";
import { claimMutationSelect } from "../src/modules/distributions/distributionClaim.service.js";

const programId = "11111111-1111-4111-8111-111111111111";
const barangayId = "22222222-2222-4222-8222-222222222222";
const otherBarangayId = "33333333-3333-4333-8333-333333333333";
const distributionId = "44444444-4444-4444-8444-444444444444";

function validDistribution(overrides = {}) {
  return {
    programId,
    title: "Emergency Assistance Distribution",
    distributionDate: new Date("2099-08-20T00:00:00.000Z"),
    startTime: new Date("1970-01-01T08:00:00.000Z"),
    endTime: new Date("1970-01-01T12:00:00.000Z"),
    slotDurationMinutes: 30,
    location: "Barangay Hall",
    barangayId,
    ...overrides,
  };
}

test("claim mutation responses include identity context for field verification", () => {
  assert.ok(claimMutationSelect.beneficiary.select.firstName);
  assert.ok(claimMutationSelect.beneficiary.select.lastName);
  assert.ok(claimMutationSelect.schedule.select.queueNumber);
});

test("System Administrator manages events while all staff roles have scoped read access", () => {
  assert.deepEqual(DISTRIBUTION_MANAGE_ROLES, ["SYSTEM_ADMIN"]);
  assert.deepEqual(DISTRIBUTION_READ_ROLES, [
    "SYSTEM_ADMIN",
    "DSWD_STAFF",
    "BARANGAY_FACILITATOR",
  ]);
  assert.doesNotThrow(() => assertDistributionManageAllowed({ role: "SYSTEM_ADMIN" }));
  assert.throws(
    () => assertDistributionManageAllowed({ role: "DSWD_STAFF" }),
    (error) => error.statusCode === 403 && error.code === "FORBIDDEN",
  );
  assert.doesNotThrow(() => assertDistributionReadAllowed({ role: "DSWD_STAFF" }));
  assert.throws(
    () => assertDistributionReadAllowed({ role: "UNKNOWN" }),
    (error) => error.statusCode === 403 && error.code === "FORBIDDEN",
  );
});

test("facilitator reads only distribution events from the assigned barangay", () => {
  const facilitator = { role: "BARANGAY_FACILITATOR", barangayId };
  assert.equal(resolveDistributionListBarangay(facilitator), barangayId);
  assert.equal(resolveDistributionListBarangay(facilitator, barangayId), barangayId);
  assert.deepEqual(distributionAccessWhere(facilitator), { barangayId });
  assert.deepEqual(distributionAccessWhere({ role: "DSWD_STAFF" }), {});
  assert.throws(
    () => resolveDistributionListBarangay(facilitator, otherBarangayId),
    (error) => error.statusCode === 403 && error.code === "FORBIDDEN",
  );
  assert.throws(
    () => distributionAccessWhere({ role: "BARANGAY_FACILITATOR", barangayId: null }),
    (error) => error.code === "BARANGAY_ASSIGNMENT_REQUIRED",
  );
});

test("distribution creation normalizes date, time, duration, and text fields", () => {
  const distribution = createDistributionSchema.parse({
    programId,
    title: " Emergency Assistance Distribution ",
    distributionDate: "2099-08-20",
    startTime: "08:00",
    endTime: "12:00",
    slotDurationMinutes: "30",
    location: " Barangay Hall ",
    barangayId,
  });

  assert.equal(distribution.title, "Emergency Assistance Distribution");
  assert.equal(distribution.distributionDate.toISOString(), "2099-08-20T00:00:00.000Z");
  assert.equal(distribution.startTime.toISOString(), "1970-01-01T08:00:00.000Z");
  assert.equal(distribution.endTime.toISOString(), "1970-01-01T12:00:00.000Z");
  assert.equal(distribution.slotDurationMinutes, 30);
  assert.equal(distribution.location, "Barangay Hall");
});

test("distribution schemas reject malformed fields and protected status updates", () => {
  const base = {
    programId,
    title: "Test Event",
    distributionDate: "2099-02-30",
    startTime: "08:00",
    endTime: "12:00",
    slotDurationMinutes: 30,
    location: "Barangay Hall",
    barangayId,
  };

  assert.equal(createDistributionSchema.safeParse(base).success, false);
  assert.equal(createDistributionSchema.safeParse({
    ...base,
    distributionDate: "2099-08-20",
    startTime: "25:00",
  }).success, false);
  assert.equal(updateDistributionSchema.safeParse({}).success, false);
  assert.equal(updateDistributionSchema.safeParse({ status: "OPEN" }).success, false);
  assert.equal(updateDistributionSchema.safeParse({ title: "Updated title" }).success, true);
});

test("distribution list filters use safe pagination and inclusive date ranges", () => {
  const query = distributionListQuerySchema.parse({
    page: "2",
    pageSize: "10",
    programId,
    barangayId,
    status: " draft ",
    dateFrom: "2099-08-01",
    dateTo: "2099-08-31",
  });

  assert.equal(query.page, 2);
  assert.equal(query.pageSize, 10);
  assert.equal(query.status, "DRAFT");
  assert.equal(query.dateFrom.toISOString(), "2099-08-01T00:00:00.000Z");
  assert.equal(query.dateTo.toISOString(), "2099-08-31T00:00:00.000Z");
  assert.equal(distributionListQuerySchema.safeParse({ pageSize: 101 }).success, false);
  assert.equal(distributionListQuerySchema.safeParse({
    dateFrom: "2099-09-01",
    dateTo: "2099-08-01",
  }).success, false);
});

test("distribution configuration rejects past dates and invalid time ranges", () => {
  const now = new Date("2026-08-12T04:00:00.000Z");
  assert.doesNotThrow(() => assertDistributionConfigurationValid(validDistribution(), now));
  assert.doesNotThrow(() => assertDistributionConfigurationValid(validDistribution({
    distributionDate: new Date("2026-08-12T00:00:00.000Z"),
  }), now));
  assert.throws(
    () => assertDistributionConfigurationValid(validDistribution({
      distributionDate: new Date("2026-08-11T00:00:00.000Z"),
    }), now),
    (error) => error.code === "DISTRIBUTION_DATE_IN_PAST",
  );
  assert.throws(
    () => assertDistributionConfigurationValid(validDistribution({
      startTime: new Date("1970-01-01T12:00:00.000Z"),
      endTime: new Date("1970-01-01T08:00:00.000Z"),
    }), now),
    (error) => error.code === "INVALID_DISTRIBUTION_TIME_RANGE",
  );
  assert.throws(
    () => assertDistributionConfigurationValid(validDistribution({
      endTime: new Date("1970-01-01T08:20:00.000Z"),
      slotDurationMinutes: 30,
    }), now),
    (error) => error.code === "INVALID_SLOT_DURATION",
  );
  assert.throws(
    () => assertDistributionConfigurationValid(validDistribution({
      endTime: new Date("1970-01-01T12:10:00.000Z"),
      slotDurationMinutes: 30,
    }), now),
    (error) => error.code === "DISTRIBUTION_SLOT_INTERVAL_UNEVEN",
  );
});

test("only draft events are editable and Phase 4 permits open or cancellation transitions", () => {
  assert.doesNotThrow(() => assertDistributionDraft({ status: "DRAFT" }));
  assert.throws(
    () => assertDistributionDraft({ status: "CANCELLED" }),
    (error) => error.code === "DISTRIBUTION_NOT_EDITABLE",
  );
  assert.doesNotThrow(() => assertDistributionTransition({ status: "DRAFT" }, "CANCELLED"));
  assert.doesNotThrow(() => assertDistributionTransition({ status: "DRAFT" }, "OPEN"));
  assert.throws(
    () => assertDistributionTransition({ status: "CANCELLED" }, "DRAFT"),
    (error) => error.code === "INVALID_DISTRIBUTION_TRANSITION",
  );
});

test("overlap query ignores the edited record and cancelled events", () => {
  const distribution = validDistribution();
  assert.deepEqual(buildDistributionOverlapWhere({
    distributionId,
    barangayId,
    distributionDate: distribution.distributionDate,
    startTime: distribution.startTime,
    endTime: distribution.endTime,
  }), {
    distributionId: { not: distributionId },
    barangayId,
    distributionDate: distribution.distributionDate,
    status: { not: "CANCELLED" },
    AND: [
      { startTime: { lt: distribution.endTime } },
      { endTime: { gt: distribution.startTime } },
    ],
  });
});

test("distribution references require an active program and active barangay", async () => {
  await assert.doesNotReject(() => assertActiveDistributionProgram(programId, {
    program: { findUnique: async () => ({ programId, status: "ACTIVE" }) },
  }));
  await assert.rejects(
    () => assertActiveDistributionProgram(programId, {
      program: { findUnique: async () => ({ programId, status: "DRAFT" }) },
    }),
    (error) => error.statusCode === 409 && error.code === "PROGRAM_NOT_ACTIVE",
  );
  await assert.rejects(
    () => assertActiveDistributionProgram(programId, {
      program: { findUnique: async () => null },
    }),
    (error) => error.statusCode === 404 && error.code === "PROGRAM_NOT_FOUND",
  );

  await assert.doesNotReject(() => assertActiveDistributionBarangay(barangayId, {
    barangay: { findUnique: async () => ({ barangayId, isActive: true }) },
  }));
  await assert.rejects(
    () => assertActiveDistributionBarangay(barangayId, {
      barangay: { findUnique: async () => ({ barangayId, isActive: false }) },
    }),
    (error) => error.statusCode === 409 && error.code === "BARANGAY_INACTIVE",
  );
  await assert.rejects(
    () => assertActiveDistributionBarangay(barangayId, {
      barangay: { findUnique: async () => null },
    }),
    (error) => error.statusCode === 404 && error.code === "BARANGAY_NOT_FOUND",
  );
});

test("overlap validation allows empty results and reports the conflicting event", async () => {
  await assert.doesNotReject(() => assertNoDistributionOverlap(validDistribution(), {
    distribution: { findFirst: async () => null },
  }));
  await assert.rejects(
    () => assertNoDistributionOverlap(validDistribution(), {
      distribution: {
        findFirst: async () => ({
          distributionId,
          title: "Existing event",
          startTime: new Date("1970-01-01T08:00:00.000Z"),
          endTime: new Date("1970-01-01T10:00:00.000Z"),
        }),
      },
    }),
    (error) => (
      error.statusCode === 409
      && error.code === "DISTRIBUTION_TIME_CONFLICT"
      && error.details.conflictingDistributionId === distributionId
    ),
  );
});

test("distribution response uses date-only and time-only values without sensitive user fields", () => {
  const response = distributionToResponse({
    ...validDistribution(),
    distributionId,
    createdBy: {},
  });
  assert.equal(response.distributionDate, "2099-08-20");
  assert.equal(response.startTime, "08:00");
  assert.equal(response.endTime, "12:00");
  assert.deepEqual(distributionSelect.createdBy.select, {
    userId: true,
    employeeId: true,
    username: true,
    fullName: true,
    role: true,
  });
  assert.equal(Object.hasOwn(distributionSelect, "slots"), false);
  assert.equal(Object.hasOwn(distributionSelect, "allocations"), false);
  assert.equal(Object.hasOwn(distributionSelect.createdBy.select, "passwordHash"), false);
  assert.equal(Object.hasOwn(distributionSelect.createdBy.select, "totpSecret"), false);
});

test("Phase 6 route surface adds simulated credit, transaction monitoring, and reconciliation", () => {
  const routes = distributionRoutes.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods),
    }));

  assert.deepEqual(routes, [
    { path: "/", methods: ["get"] },
    { path: "/", methods: ["post"] },
    { path: "/assistant-preview", methods: ["post"] },
    { path: "/:distributionId/slots", methods: ["get"] },
    { path: "/:distributionId/slots/generate", methods: ["post"] },
    { path: "/:distributionId/slots/:slotId", methods: ["get"] },
    { path: "/:distributionId/slots/:slotId", methods: ["patch"] },
    { path: "/:distributionId/slots/:slotId/close", methods: ["post"] },
    { path: "/:distributionId/slots/:slotId/reopen", methods: ["post"] },
    { path: "/:distributionId/eligible-enrollments", methods: ["get"] },
    { path: "/:distributionId/allocations", methods: ["post"] },
    { path: "/:distributionId/allocations", methods: ["get"] },
    { path: "/:distributionId/allocations/:allocationId", methods: ["get"] },
    { path: "/:distributionId/allocations/:allocationId/cancel", methods: ["post"] },
    { path: "/:distributionId/allocations/:allocationId/reactivate", methods: ["post"] },
    { path: "/:distributionId/schedulable-allocations", methods: ["get"] },
    { path: "/:distributionId/schedules/generate", methods: ["post"] },
    { path: "/:distributionId/schedules", methods: ["post"] },
    { path: "/:distributionId/schedules", methods: ["get"] },
    { path: "/:distributionId/schedules/:scheduleId", methods: ["get"] },
    { path: "/:distributionId/schedules/:scheduleId/reschedule", methods: ["post"] },
    { path: "/:distributionId/schedules/:scheduleId/cancel", methods: ["post"] },
    { path: "/:distributionId/schedules/:scheduleId/reactivate", methods: ["post"] },
    { path: "/:distributionId/open", methods: ["post"] },
    { path: "/:distributionId/qr-eligible-schedules", methods: ["get"] },
    { path: "/:distributionId/qr-tokens/generate", methods: ["post"] },
    { path: "/:distributionId/qr-tokens", methods: ["get"] },
    { path: "/:distributionId/qr-tokens/:qrTokenId", methods: ["get"] },
    { path: "/:distributionId/qr-tokens/:qrTokenId/revoke", methods: ["post"] },
    { path: "/:distributionId/qr-tokens/:qrTokenId/reissue", methods: ["post"] },
      { path: "/:distributionId/claims/preview-qr", methods: ["post"] },
      { path: "/:distributionId/claims/verify-qr", methods: ["post"] },
      { path: "/:distributionId/claims/verify-biometric", methods: ["post"] },
      { path: "/:distributionId/claims/:claimId/signature", methods: ["post"] },
      { path: "/:distributionId/claims/:claimId/receipt", methods: ["post"] },
      { path: "/:distributionId/claims/:claimId/receipt/print-events", methods: ["post"] },
      { path: "/:distributionId/claims/:claimId/disputes", methods: ["post"] },
      { path: "/:distributionId/claim-disputes", methods: ["get"] },
      { path: "/:distributionId/claim-disputes/:disputeId/review", methods: ["post"] },
      { path: "/:distributionId/biometric-attempts", methods: ["get"] },
      { path: "/:distributionId/claims", methods: ["get"] },
    { path: "/:distributionId/claims/:claimId", methods: ["get"] },
    { path: "/:distributionId/creditable-claims", methods: ["get"] },
    { path: "/:distributionId/claims/:claimId/credit", methods: ["post"] },
    { path: "/:distributionId/transactions", methods: ["get"] },
    { path: "/:distributionId/reconciliation", methods: ["get"] },
    { path: "/:distributionId/qr-scan-logs", methods: ["get"] },
    { path: "/:distributionId", methods: ["get"] },
    { path: "/:distributionId", methods: ["patch"] },
    { path: "/:distributionId/cancel", methods: ["post"] },
  ]);
  assert.equal(routes.some((route) => route.methods.includes("delete")), false);
  assert.equal(
    routes.some((route) => /transaction|wallet|payout/.test(route.path)),
    true,
  );
});
