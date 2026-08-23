import test from "node:test";
import assert from "node:assert/strict";
import {
  distributionSlotListQuerySchema,
  distributionSlotParamsSchema,
  generateDistributionSlotsSchema,
  updateDistributionSlotSchema,
} from "../src/modules/distributions/distributionSlot.schemas.js";
import {
  assertDistributionScheduleFieldsUnlocked,
  assertDistributionSlotsManageable,
  assertDistributionSlotTransition,
  buildDistributionSlotRows,
  distributionSlotSelect,
  distributionSlotToResponse,
} from "../src/modules/distributions/distributionSlot.service.js";

const distributionId = "11111111-1111-4111-8111-111111111111";
const slotId = "22222222-2222-4222-8222-222222222222";

function distribution(overrides = {}) {
  return {
    distributionId,
    distributionDate: new Date("2099-08-20T00:00:00.000Z"),
    startTime: new Date("1970-01-01T08:00:00.000Z"),
    endTime: new Date("1970-01-01T10:00:00.000Z"),
    slotDurationMinutes: 30,
    status: "DRAFT",
    ...overrides,
  };
}

test("slot schemas validate capacity, identifiers, filters, and pagination", () => {
  assert.deepEqual(generateDistributionSlotsSchema.parse({ capacity: "30" }), {
    capacity: 30,
  });
  assert.deepEqual(updateDistributionSlotSchema.parse({ capacity: 40 }), {
    capacity: 40,
  });
  assert.deepEqual(distributionSlotParamsSchema.parse({ distributionId, slotId }), {
    distributionId,
    slotId,
  });

  const query = distributionSlotListQuerySchema.parse({
    page: "2",
    pageSize: "10",
    slotStatus: " closed ",
  });
  assert.deepEqual(query, { page: 2, pageSize: 10, slotStatus: "CLOSED" });
  assert.equal(generateDistributionSlotsSchema.safeParse({ capacity: 0 }).success, false);
  assert.equal(generateDistributionSlotsSchema.safeParse({ capacity: 1001 }).success, false);
  assert.equal(updateDistributionSlotSchema.safeParse({ capacity: 20, status: "FULL" }).success, false);
  assert.equal(distributionSlotListQuerySchema.safeParse({ slotStatus: "UNKNOWN" }).success, false);
});

test("slot generation creates exact non-overlapping Philippine-time intervals", () => {
  const rows = buildDistributionSlotRows(distribution(), 30);

  assert.equal(rows.length, 4);
  assert.equal(rows[0].slotStart.toISOString(), "2099-08-20T00:00:00.000Z");
  assert.equal(rows[0].slotEnd.toISOString(), "2099-08-20T00:30:00.000Z");
  assert.equal(rows[3].slotStart.toISOString(), "2099-08-20T01:30:00.000Z");
  assert.equal(rows[3].slotEnd.toISOString(), "2099-08-20T02:00:00.000Z");
  assert.equal(rows.every((row) => row.capacity === 30), true);
  assert.equal(rows.every((row) => row.slotStatus === "AVAILABLE"), true);
});

test("slot generation rejects an event range that does not divide evenly", () => {
  assert.throws(
    () => buildDistributionSlotRows(distribution({
      endTime: new Date("1970-01-01T10:10:00.000Z"),
    }), 30),
    (error) => error.statusCode === 409 && error.code === "DISTRIBUTION_SLOT_INTERVAL_UNEVEN",
  );
});

test("slot responses use explicit Asia/Manila timestamps and exclude related sensitive data", () => {
  const row = buildDistributionSlotRows(distribution(), 30)[0];
  const response = distributionSlotToResponse({
    ...row,
    slotId,
    createdAt: new Date("2099-01-01T00:00:00.000Z"),
    updatedAt: new Date("2099-01-01T00:00:00.000Z"),
  });

  assert.equal(response.slotStart, "2099-08-20T08:00:00+08:00");
  assert.equal(response.slotEnd, "2099-08-20T08:30:00+08:00");
  assert.deepEqual(Object.keys(distributionSlotSelect), [
    "slotId",
    "distributionId",
    "slotStart",
    "slotEnd",
    "capacity",
    "slotStatus",
    "createdAt",
    "updatedAt",
  ]);
});

test("only draft events permit slot management and transitions are controlled", () => {
  assert.doesNotThrow(() => assertDistributionSlotsManageable({ status: "DRAFT" }));
  assert.throws(
    () => assertDistributionSlotsManageable({ status: "CANCELLED" }),
    (error) => error.code === "DISTRIBUTION_SLOTS_NOT_EDITABLE",
  );
  assert.doesNotThrow(() => assertDistributionSlotTransition({ slotStatus: "AVAILABLE" }, "CLOSED"));
  assert.doesNotThrow(() => assertDistributionSlotTransition({ slotStatus: "CLOSED" }, "AVAILABLE"));
  assert.throws(
    () => assertDistributionSlotTransition({ slotStatus: "AVAILABLE" }, "AVAILABLE"),
    (error) => error.code === "INVALID_DISTRIBUTION_SLOT_TRANSITION",
  );
});

test("generated slots lock only the event scheduling fields", async () => {
  let countCalls = 0;
  const database = {
    distributionSlot: {
      count: async () => {
        countCalls += 1;
        return 1;
      },
    },
  };

  await assert.doesNotReject(() => assertDistributionScheduleFieldsUnlocked(
    { title: "Updated title", location: "Updated hall" },
    distributionId,
    database,
  ));
  assert.equal(countCalls, 0);

  await assert.rejects(
    () => assertDistributionScheduleFieldsUnlocked(
      { startTime: new Date("1970-01-01T09:00:00.000Z") },
      distributionId,
      database,
    ),
    (error) => error.statusCode === 409 && error.code === "DISTRIBUTION_SCHEDULE_LOCKED",
  );
  assert.equal(countCalls, 1);
});
