import test from "node:test";
import assert from "node:assert/strict";
import {
  createDistributionScheduleSchema,
  distributionScheduleListQuerySchema,
  distributionScheduleParamsSchema,
  generateDistributionSchedulesSchema,
  rescheduleDistributionScheduleSchema,
  schedulableAllocationListQuerySchema,
} from "../src/modules/distributions/distributionSchedule.schemas.js";
import {
  activeScheduleCount,
  assertAllocationSchedulable,
  assertDistributionScheduleReschedulable,
  assertDistributionSchedulesManageable,
  assertDistributionScheduleTransition,
  assertSlotAvailable,
  buildSchedulableAllocationSearchWhere,
  buildScheduleSearchWhere,
  distributionOpeningReadiness,
  distributionScheduleSelect,
  distributionScheduleToResponse,
  nextSlotQueueNumber,
  schedulableAllocationToResponse,
  scheduleBeneficiarySelect,
  scheduleGenerationRequestHash,
} from "../src/modules/distributions/distributionSchedule.service.js";

const distributionId = "11111111-1111-4111-8111-111111111111";
const allocationId = "22222222-2222-4222-8222-222222222222";
const secondAllocationId = "33333333-3333-4333-8333-333333333333";
const slotId = "44444444-4444-4444-8444-444444444444";
const targetSlotId = "55555555-5555-4555-8555-555555555555";
const scheduleId = "66666666-6666-4666-8666-666666666666";
const beneficiaryId = "77777777-7777-4777-8777-777777777777";

test("schedule schemas validate manual assignment, generation, filters, and rescheduling", () => {
  assert.deepEqual(createDistributionScheduleSchema.parse({ allocationId, slotId }), {
    allocationId,
    slotId,
  });
  assert.deepEqual(generateDistributionSchedulesSchema.parse({}), {});
  assert.deepEqual(generateDistributionSchedulesSchema.parse({
    allocationIds: [allocationId, secondAllocationId],
  }), { allocationIds: [allocationId, secondAllocationId] });
  assert.equal(generateDistributionSchedulesSchema.safeParse({
    allocationIds: [allocationId, allocationId],
  }).success, false);
  assert.deepEqual(rescheduleDistributionScheduleSchema.parse({ slotId: targetSlotId }), {
    slotId: targetSlotId,
  });
  assert.deepEqual(distributionScheduleParamsSchema.parse({ distributionId, scheduleId }), {
    distributionId,
    scheduleId,
  });
  assert.deepEqual(distributionScheduleListQuerySchema.parse({
    page: "2",
    pageSize: "10",
    status: " cancelled ",
    slotId,
    search: " Dela Cruz ",
  }), {
    page: 2,
    pageSize: 10,
    status: "CANCELLED",
    slotId,
    search: "Dela Cruz",
  });
  assert.deepEqual(schedulableAllocationListQuerySchema.parse({}), {
    page: 1,
    pageSize: 20,
  });
});

test("schedule generation request hashing is stable and body-sensitive", () => {
  assert.equal(
    scheduleGenerationRequestHash([allocationId, secondAllocationId]),
    scheduleGenerationRequestHash([secondAllocationId, allocationId]),
  );
  assert.notEqual(
    scheduleGenerationRequestHash([allocationId]),
    scheduleGenerationRequestHash([secondAllocationId]),
  );
  assert.notEqual(scheduleGenerationRequestHash(), scheduleGenerationRequestHash([allocationId]));
});

test("schedule mutations require draft events and allocated beneficiaries", () => {
  assert.doesNotThrow(() => assertDistributionSchedulesManageable({ status: "DRAFT" }));
  assert.throws(
    () => assertDistributionSchedulesManageable({ status: "OPEN" }),
    (error) => error.code === "DISTRIBUTION_SCHEDULES_NOT_EDITABLE",
  );
  assert.doesNotThrow(() => assertAllocationSchedulable({
    allocationId,
    allocationStatus: "ALLOCATED",
  }));
  assert.throws(
    () => assertAllocationSchedulable({ allocationId, allocationStatus: "CANCELLED" }),
    (error) => error.code === "ALLOCATION_NOT_SCHEDULABLE",
  );
});

test("slot availability and capacity are both enforced", () => {
  const slot = { slotId, slotStatus: "AVAILABLE", capacity: 2 };
  assert.doesNotThrow(() => assertSlotAvailable(slot, 1));
  assert.throws(
    () => assertSlotAvailable(slot, 2),
    (error) => error.code === "DISTRIBUTION_SLOT_CAPACITY_EXCEEDED",
  );
  assert.throws(
    () => assertSlotAvailable({ ...slot, slotStatus: "CLOSED" }, 0),
    (error) => error.code === "DISTRIBUTION_SLOT_NOT_AVAILABLE",
  );
});

test("schedule cancel/reactivate and reschedule transitions are controlled", () => {
  assert.doesNotThrow(() => assertDistributionScheduleTransition(
    { status: "SCHEDULED" },
    "CANCELLED",
  ));
  assert.doesNotThrow(() => assertDistributionScheduleTransition(
    { status: "CANCELLED" },
    "SCHEDULED",
  ));
  assert.throws(
    () => assertDistributionScheduleTransition({ status: "CHECKED_IN" }, "CANCELLED"),
    (error) => error.code === "INVALID_DISTRIBUTION_SCHEDULE_TRANSITION",
  );
  assert.doesNotThrow(() => assertDistributionScheduleReschedulable(
    { status: "SCHEDULED", slotId },
    targetSlotId,
  ));
  assert.throws(
    () => assertDistributionScheduleReschedulable({ status: "SCHEDULED", slotId }, slotId),
    (error) => error.code === "DISTRIBUTION_SCHEDULE_SLOT_UNCHANGED",
  );
  assert.throws(
    () => assertDistributionScheduleReschedulable(
      { status: "CANCELLED", slotId },
      targetSlotId,
    ),
    (error) => error.code === "DISTRIBUTION_SCHEDULE_NOT_RESCHEDULABLE",
  );
});

test("queue helpers count occupying schedules and never reuse queue numbers", async () => {
  const calls = [];
  const database = {
    schedule: {
      count: async (query) => {
        calls.push(query);
        return 2;
      },
      aggregate: async () => ({ _max: { queueNumber: 7 } }),
    },
  };
  assert.equal(await activeScheduleCount(slotId, database), 2);
  assert.equal(await nextSlotQueueNumber(slotId, database), 8);
  assert.deepEqual(calls[0].where.status.in, ["SCHEDULED", "CHECKED_IN", "MISSED"]);
});

test("search helpers support beneficiary names, UUIDs, and queue numbers", () => {
  assert.deepEqual(buildScheduleSearchWhere(), {});
  assert.equal(buildScheduleSearchWhere("Pedro").OR.length, 4);
  assert.equal(buildScheduleSearchWhere(scheduleId).OR.length, 7);
  assert.equal(buildScheduleSearchWhere("12").OR.length, 5);
  assert.deepEqual(buildSchedulableAllocationSearchWhere(), {});
  assert.equal(buildSchedulableAllocationSearchWhere("Pedro").OR.length, 4);
  assert.equal(buildSchedulableAllocationSearchWhere(allocationId).OR.length, 7);
});

test("opening readiness requires every active allocation to have a capacity-safe schedule", async () => {
  const database = {
    distributionAllocation: {
      findMany: async () => [{ allocationId, beneficiaryId }],
    },
    schedule: {
      findMany: async () => [{
        scheduleId,
        beneficiaryId,
        slotId,
        status: "SCHEDULED",
        beneficiary: { sitioPurok: "Sitio Riverside" },
        slot: { distributionId, capacity: 1, serviceAreas: ["Sitio Riverside"] },
      }],
    },
  };
  assert.deepEqual(await distributionOpeningReadiness(distributionId, database), {
    activeAllocationCount: 1,
    activeScheduleCount: 1,
    slotCount: 1,
  });

  await assert.rejects(
    () => distributionOpeningReadiness(distributionId, {
      ...database,
      schedule: { findMany: async () => [] },
    }),
    (error) => (
      error.code === "DISTRIBUTION_ALLOCATIONS_UNSCHEDULED"
      && error.details.unscheduledAllocationCount === 1
    ),
  );
  await assert.rejects(
    () => distributionOpeningReadiness(distributionId, {
      distributionAllocation: { findMany: async () => [] },
      schedule: { findMany: async () => [] },
    }),
    (error) => error.code === "DISTRIBUTION_NO_ACTIVE_ALLOCATIONS",
  );
});

test("schedule responses expose operational fields but omit sensitive beneficiary data", () => {
  const response = distributionScheduleToResponse({
    scheduleId,
    slot: {
      slotId,
      distributionId,
      slotStart: new Date("2099-08-20T00:00:00.000Z"),
      slotEnd: new Date("2099-08-20T00:30:00.000Z"),
      capacity: 10,
      slotStatus: "AVAILABLE",
    },
  });
  assert.equal(response.slot.slotStart, "2099-08-20T08:00:00+08:00");
  assert.equal(response.slot.slotEnd, "2099-08-20T08:30:00+08:00");
  assert.equal(Object.hasOwn(scheduleBeneficiarySelect, "address"), false);
  assert.equal(Object.hasOwn(scheduleBeneficiarySelect, "contactNumber"), false);
  assert.equal(Object.hasOwn(scheduleBeneficiarySelect, "email"), false);
  assert.equal(Object.hasOwn(scheduleBeneficiarySelect, "philsysNumber"), false);
  assert.equal(Object.hasOwn(distributionScheduleSelect, "claim"), false);
  assert.equal(schedulableAllocationToResponse({ amount: { toString: () => "5000.00" } }).amount, "5000.00");
});
