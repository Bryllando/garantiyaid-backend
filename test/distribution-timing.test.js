import test from "node:test";
import assert from "node:assert/strict";

// Isolated controller fixtures: no database writes, notifications, or live credentials.
const prisma = { distribution: {}, schedule: {}, idempotencyRecord: {}, $transaction: async () => {} };
globalThis.prisma = prisma;
const { listQrEligibleSchedules } = await import("../src/modules/distributions/distributionClaim.controller.js");
const { generateDistributionSchedules } = await import("../src/modules/distributions/distributionSchedule.controller.js");
const { createDistribution, previewAssistantDistribution, updateDistribution } = await import("../src/modules/distributions/distribution.controller.js");
const distributionId = "11111111-1111-4111-8111-111111111111";
const req = { staffUser: { role: "SYSTEM_ADMIN" }, validatedParams: { distributionId } };
const invoke = (handler, request) => new Promise((resolve, reject) => handler(request, {
  status() { return this; }, json: resolve,
}, reject));

test("create and assistant preview reject elapsed windows while package-only edits remain available", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-16T06:00:00Z") });
  const fields = {
    distributionDate: new Date("2026-11-16T00:00:00Z"),
    startTime: new Date("1970-01-01T08:00:00Z"), endTime: new Date("1970-01-01T12:00:00Z"),
    slotDurationMinutes: 30, deliveryMode: "PHYSICAL_GOODS", verificationRequirement: "QR",
  };
  for (const handler of [createDistribution, previewAssistantDistribution]) {
    await assert.rejects(invoke(handler, { ...req, validatedBody: fields }), error => error.code === "DISTRIBUTION_WINDOW_ENDED");
  }
  prisma.distribution.findFirst = async () => ({ ...fields, distributionId, status: "DRAFT" });
  const stopped = new Error("Stopped before fixture writes");
  prisma.$transaction = async () => { throw stopped; };
  await assert.rejects(invoke(updateDistribution, {
    ...req, validatedBody: { packageName: "Food pack", packageUnit: "pack", packageQuantity: 1 },
  }), error => error === stopped);
  await assert.rejects(invoke(updateDistribution, {
    ...req, validatedBody: { endTime: fields.endTime },
  }), error => error.code === "DISTRIBUTION_WINDOW_ENDED");
});

test("QR eligibility explains ended appointments without returning a usable credential", async () => {
  prisma.distribution.findFirst = async () => ({ distributionId, status: "OPEN", verificationRequirement: "QR" });
  const queries = [];
  prisma.schedule.findMany = async ({ where }) => {
    assert.ok(where.slot.slotEnd.gt instanceof Date);
    assert.deepEqual(where.beneficiary.qrTokens, { none: { distributionId } });
    return [];
  };
  prisma.schedule.count = async ({ where }) => {
    queries.push(where);
    return where.beneficiary ? 0 : 1;
  };
  const result = await invoke(listQrEligibleSchedules, { ...req, validatedQuery: { page: 1, pageSize: 20 } });
  assert.deepEqual(result.data.schedules, []);
  assert.equal(result.data.summary.qrEligibleScheduleCount, 0);
  assert.equal(result.data.summary.scheduledCount, 1);
  assert.equal(result.data.summary.endedScheduleCount, 1);
  const cutoff = new Date(result.data.summary.checkedAt);
  assert.equal(queries[0].slot.slotEnd.gt.getTime(), cutoff.getTime());
  assert.equal(queries[2].slot.slotEnd.lte.getTime(), cutoff.getTime());
});

test("automatic scheduling queries only unexpired slots and rejects an ended-only queue", async () => {
  let queried = false;
  prisma.idempotencyRecord.deleteMany = async () => ({ count: 0 });
  prisma.idempotencyRecord.findUnique = async () => null;
  const tx = {
    idempotencyRecord: prisma.idempotencyRecord,
    distribution: { findFirst: async () => ({ distributionId, status: "DRAFT" }) },
    distributionAllocation: { findMany: async () => [{ allocationId: "allocation-1", beneficiaryId: "person-1" }] },
    distributionSlot: { findMany: async ({ where }) => {
      queried = true;
      assert.equal(where.distributionId, distributionId);
      assert.equal(where.slotStatus, "AVAILABLE");
      assert.ok(where.slotEnd.gt instanceof Date);
      return [];
    } },
  };
  prisma.$transaction = async operation => operation(tx);
  await assert.rejects(invoke(generateDistributionSchedules, {
    ...req, auth: { userId: "admin-1" }, validatedBody: {},
    get: () => "22222222-2222-4222-8222-222222222222",
  }), error => error.code === "INSUFFICIENT_DISTRIBUTION_SLOT_CAPACITY" && /unexpired/.test(error.message));
  assert.equal(queried, true);
});
