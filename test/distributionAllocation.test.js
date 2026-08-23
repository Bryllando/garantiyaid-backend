import test from "node:test";
import assert from "node:assert/strict";
import {
  createDistributionAllocationsSchema,
  distributionAllocationListQuerySchema,
  distributionAllocationParamsSchema,
  eligibleEnrollmentListQuerySchema,
  idempotencyKeySchema,
} from "../src/modules/distributions/distributionAllocation.schemas.js";
import {
  allocationBeneficiarySelect,
  allocationGrantAmount,
  allocationRequestHash,
  assertDistributionAllocationFieldsUnlocked,
  assertDistributionAllocationsManageable,
  assertDistributionAllocationTransition,
  assertProgramBudgetAvailable,
  assertRequestedEnrollmentsEligible,
  buildAllocationSearchWhere,
  buildEligibleEnrollmentSearchWhere,
  distributionAllocationSelect,
  distributionAllocationToResponse,
} from "../src/modules/distributions/distributionAllocation.service.js";

const distributionId = "11111111-1111-4111-8111-111111111111";
const allocationId = "22222222-2222-4222-8222-222222222222";
const firstEnrollmentId = "33333333-3333-4333-8333-333333333333";
const secondEnrollmentId = "44444444-4444-4444-8444-444444444444";
const programId = "55555555-5555-4555-8555-555555555555";
const barangayId = "66666666-6666-4666-8666-666666666666";

function enrollment(overrides = {}) {
  return {
    enrollmentId: firstEnrollmentId,
    beneficiaryId: "77777777-7777-4777-8777-777777777777",
    programId,
    status: "APPROVED",
    beneficiary: {
      barangayId,
      status: "ACTIVE",
    },
    ...overrides,
  };
}

const distribution = { distributionId, programId, barangayId, status: "DRAFT" };

test("allocation schemas validate batch size, unique IDs, filters, and idempotency UUIDs", () => {
  assert.deepEqual(createDistributionAllocationsSchema.parse({
    enrollmentIds: [firstEnrollmentId, secondEnrollmentId],
  }), { enrollmentIds: [firstEnrollmentId, secondEnrollmentId] });
  assert.equal(createDistributionAllocationsSchema.safeParse({ enrollmentIds: [] }).success, false);
  assert.equal(createDistributionAllocationsSchema.safeParse({
    enrollmentIds: [firstEnrollmentId, firstEnrollmentId],
  }).success, false);
  assert.equal(createDistributionAllocationsSchema.safeParse({
    enrollmentIds: Array.from({ length: 101 }, (_, index) => (
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
    )),
  }).success, false);

  assert.deepEqual(distributionAllocationParamsSchema.parse({ distributionId, allocationId }), {
    distributionId,
    allocationId,
  });
  assert.deepEqual(distributionAllocationListQuerySchema.parse({
    page: "2",
    pageSize: "10",
    status: " cancelled ",
    search: " Dela Cruz ",
  }), { page: 2, pageSize: 10, status: "CANCELLED", search: "Dela Cruz" });
  assert.deepEqual(eligibleEnrollmentListQuerySchema.parse({}), {
    page: 1,
    pageSize: 20,
  });
  assert.equal(idempotencyKeySchema.safeParse(allocationId).success, true);
  assert.equal(idempotencyKeySchema.safeParse("not-a-uuid").success, false);
});

test("allocation request hashing is order-independent but changes with the request body", () => {
  assert.equal(
    allocationRequestHash([firstEnrollmentId, secondEnrollmentId]),
    allocationRequestHash([secondEnrollmentId, firstEnrollmentId]),
  );
  assert.notEqual(
    allocationRequestHash([firstEnrollmentId]),
    allocationRequestHash([firstEnrollmentId, secondEnrollmentId]),
  );
});

test("allocation eligibility requires approved, same-program, same-barangay active beneficiaries", () => {
  assert.doesNotThrow(() => assertRequestedEnrollmentsEligible(
    [enrollment()],
    [firstEnrollmentId],
    distribution,
  ));
  assert.throws(
    () => assertRequestedEnrollmentsEligible([], [firstEnrollmentId], distribution),
    (error) => error.code === "ENROLLMENT_NOT_ELIGIBLE_FOR_ALLOCATION",
  );
  assert.throws(
    () => assertRequestedEnrollmentsEligible(
      [enrollment({ status: "PENDING" })],
      [firstEnrollmentId],
      distribution,
    ),
    (error) => error.code === "ENROLLMENT_NOT_APPROVED",
  );
  assert.throws(
    () => assertRequestedEnrollmentsEligible(
      [enrollment({ programId: allocationId })],
      [firstEnrollmentId],
      distribution,
    ),
    (error) => error.code === "ENROLLMENT_PROGRAM_MISMATCH",
  );
  assert.throws(
    () => assertRequestedEnrollmentsEligible(
      [enrollment({ beneficiary: { barangayId: allocationId, status: "ACTIVE" } })],
      [firstEnrollmentId],
      distribution,
    ),
    (error) => error.code === "ENROLLMENT_BARANGAY_MISMATCH",
  );
  assert.throws(
    () => assertRequestedEnrollmentsEligible(
      [enrollment({ beneficiary: { barangayId, status: "INACTIVE" } })],
      [firstEnrollmentId],
      distribution,
    ),
    (error) => error.code === "BENEFICIARY_NOT_ACTIVE",
  );
});

test("grant and budget rules derive server-side amounts and block overspending", () => {
  assert.equal(allocationGrantAmount({ status: "ACTIVE", grantAmount: "1000.00" }), 1000);
  assert.throws(
    () => allocationGrantAmount({ status: "ACTIVE", grantAmount: null }),
    (error) => error.code === "PROGRAM_GRANT_AMOUNT_REQUIRED",
  );
  assert.throws(
    () => allocationGrantAmount({ status: "CLOSED", grantAmount: "1000.00" }),
    (error) => error.code === "PROGRAM_NOT_ACTIVE",
  );
  assert.doesNotThrow(() => assertProgramBudgetAvailable({
    budgetAmount: "10000.00",
    allocatedAmount: "8000.00",
    requestedAmount: 2000,
  }));
  assert.doesNotThrow(() => assertProgramBudgetAvailable({
    budgetAmount: null,
    allocatedAmount: "999999.00",
    requestedAmount: 1000,
  }));
  assert.throws(
    () => assertProgramBudgetAvailable({
      budgetAmount: "10000.00",
      allocatedAmount: "9000.00",
      requestedAmount: 2000,
    }),
    (error) => (
      error.code === "PROGRAM_BUDGET_EXCEEDED"
      && error.details.remainingAmount === "1000.00"
    ),
  );
});

test("only draft events allow allocation mutations and lifecycle transitions are controlled", () => {
  assert.doesNotThrow(() => assertDistributionAllocationsManageable({ status: "DRAFT" }));
  assert.throws(
    () => assertDistributionAllocationsManageable({ status: "CANCELLED" }),
    (error) => error.code === "DISTRIBUTION_ALLOCATIONS_NOT_EDITABLE",
  );
  assert.doesNotThrow(() => assertDistributionAllocationTransition(
    { allocationStatus: "ALLOCATED" },
    "CANCELLED",
  ));
  assert.doesNotThrow(() => assertDistributionAllocationTransition(
    { allocationStatus: "CANCELLED" },
    "ALLOCATED",
  ));
  assert.throws(
    () => assertDistributionAllocationTransition({ allocationStatus: "CLAIMED" }, "CANCELLED"),
    (error) => error.code === "CLAIMED_ALLOCATION_IMMUTABLE",
  );
  assert.throws(
    () => assertDistributionAllocationTransition({ allocationStatus: "PENDING" }, "ALLOCATED"),
    (error) => error.code === "INVALID_DISTRIBUTION_ALLOCATION_TRANSITION",
  );
});

test("allocation scope fields lock after the first allocation but unrelated event fields remain editable", async () => {
  let countCalls = 0;
  const database = {
    distributionAllocation: {
      count: async () => {
        countCalls += 1;
        return 1;
      },
    },
  };
  await assert.doesNotReject(() => assertDistributionAllocationFieldsUnlocked(
    { title: "Updated title", location: "Updated location" },
    distributionId,
    database,
  ));
  assert.equal(countCalls, 0);
  await assert.rejects(
    () => assertDistributionAllocationFieldsUnlocked(
      { programId },
      distributionId,
      database,
    ),
    (error) => error.code === "DISTRIBUTION_ALLOCATION_SCOPE_LOCKED",
  );
});

test("search helpers support names and exact UUID identifiers", () => {
  assert.deepEqual(buildAllocationSearchWhere(undefined), {});
  assert.equal(buildAllocationSearchWhere("Dela Cruz").OR.length, 3);
  assert.equal(buildAllocationSearchWhere(allocationId).OR.length, 6);
  assert.deepEqual(buildEligibleEnrollmentSearchWhere(undefined), {});
  assert.equal(buildEligibleEnrollmentSearchWhere("Juan").OR.length, 3);
  assert.equal(buildEligibleEnrollmentSearchWhere(firstEnrollmentId).OR.length, 5);
});

test("allocation responses expose only operational identity fields and stringify money", () => {
  const response = distributionAllocationToResponse({
    allocationId,
    amount: { toString: () => "1000.00" },
  });
  assert.equal(response.amount, "1000.00");
  assert.deepEqual(Object.keys(allocationBeneficiarySelect), [
    "beneficiaryId",
    "firstName",
    "middleName",
    "lastName",
    "barangayId",
    "status",
    "barangay",
  ]);
  assert.equal(Object.hasOwn(allocationBeneficiarySelect, "address"), false);
  assert.equal(Object.hasOwn(allocationBeneficiarySelect, "contactNumber"), false);
  assert.equal(Object.hasOwn(allocationBeneficiarySelect, "email"), false);
  assert.equal(Object.hasOwn(allocationBeneficiarySelect, "philsysNumber"), false);
  assert.equal(Object.hasOwn(distributionAllocationSelect.allocatedBy.select, "passwordHash"), false);
  assert.equal(Object.hasOwn(distributionAllocationSelect.allocatedBy.select, "totpSecret"), false);
  assert.equal(Object.hasOwn(distributionAllocationSelect, "claim"), false);
});
