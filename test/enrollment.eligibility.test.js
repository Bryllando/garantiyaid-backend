import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateAgeOnDate,
  evaluateEnrollmentEligibility,
} from "../src/modules/enrollments/enrollmentEligibility.service.js";
import { enrollmentApprovalSchema } from "../src/modules/enrollments/enrollment.schemas.js";

const barangayId = "11111111-1111-4111-8111-111111111111";
const otherBarangayId = "22222222-2222-4222-8222-222222222222";
const criterionIds = {
  age: "33333333-3333-4333-8333-333333333333",
  sex: "44444444-4444-4444-8444-444444444444",
  barangay: "55555555-5555-4555-8555-555555555555",
  document: "66666666-6666-4666-8666-666666666666",
  manual: "77777777-7777-4777-8777-777777777777",
};

function criterion(overrides = {}) {
  return {
    criterionId: criterionIds.age,
    criterionName: "Adult beneficiary",
    fieldName: "AGE",
    operator: "GREATER_THAN_OR_EQUAL",
    expectedValue: 18,
    isRequired: true,
    ...overrides,
  };
}

function enrollment(criteria, beneficiaryOverrides = {}) {
  return {
    enrollmentId: "88888888-8888-4888-8888-888888888888",
    enrollmentDate: new Date("2026-09-17T00:00:00.000Z"),
    program: {
      programId: "99999999-9999-4999-8999-999999999999",
      criteria,
    },
    beneficiary: {
      birthDate: new Date("1990-09-18T00:00:00.000Z"),
      sex: "FEMALE",
      barangayId,
      documents: [],
      ...beneficiaryOverrides,
    },
  };
}

test("age uses the stored enrollment date and handles birthday boundaries", () => {
  assert.equal(calculateAgeOnDate("2008-09-18", "2026-09-17"), 17);
  assert.equal(calculateAgeOnDate("2008-09-18", "2026-09-18"), 18);
  assert.equal(calculateAgeOnDate("2008-02-29", "2026-02-28"), 17);
  assert.equal(calculateAgeOnDate("2008-02-29", "2026-03-01"), 18);
});

test("supported automatic criteria produce an eligible, auditable result", () => {
  const result = evaluateEnrollmentEligibility(enrollment([
    criterion(),
    criterion({
      criterionId: criterionIds.sex,
      criterionName: "Eligible sex",
      fieldName: "SEX",
      operator: "IN",
      expectedValue: ["FEMALE", "OTHER"],
    }),
    criterion({
      criterionId: criterionIds.barangay,
      criterionName: "Covered barangay",
      fieldName: "BARANGAY_ID",
      operator: "NOT_IN",
      expectedValue: [otherBarangayId],
    }),
    criterion({
      criterionId: criterionIds.document,
      criterionName: "Accepted birth certificate",
      fieldName: "DOCUMENT_TYPE",
      operator: "REQUIRED",
      expectedValue: "BIRTH_CERTIFICATE",
    }),
  ], {
    documents: [{ documentType: "BIRTH_CERTIFICATE", reviewStatus: "ACCEPTED" }],
  }));

  assert.equal(result.overallStatus, "ELIGIBLE");
  assert.equal(result.referenceDate, "2026-09-17");
  assert.deepEqual(result.summary, {
    total: 4,
    met: 4,
    notMet: 0,
    reviewRequired: 0,
    blocking: 0,
  });
  assert.equal(result.results[0].actualValue, 35);
});

test("a required failure blocks approval while an optional failure stays visible", () => {
  const result = evaluateEnrollmentEligibility(enrollment([
    criterion({ operator: "GREATER_THAN", expectedValue: 40 }),
    criterion({
      criterionId: criterionIds.sex,
      criterionName: "Advisory sex check",
      fieldName: "SEX",
      operator: "NOT_EQUALS",
      expectedValue: "FEMALE",
      isRequired: false,
    }),
  ]));

  assert.equal(result.overallStatus, "INELIGIBLE");
  assert.equal(result.results[0].blocking, true);
  assert.equal(result.results[1].outcome, "NOT_MET");
  assert.equal(result.results[1].blocking, false);
});

test("only accepted documents satisfy a document criterion", async (t) => {
  for (const reviewStatus of ["SUBMITTED", "REJECTED", "SUPERSEDED"]) {
    await t.test(reviewStatus, () => {
      const result = evaluateEnrollmentEligibility(enrollment([
        criterion({
          criterionId: criterionIds.document,
          fieldName: "DOCUMENT_TYPE",
          operator: "REQUIRED",
          expectedValue: "VALID_ID",
        }),
      ], { documents: [{ documentType: "VALID_ID", reviewStatus }] }));
      assert.equal(result.overallStatus, "INELIGIBLE");
    });
  }

  const accepted = evaluateEnrollmentEligibility(enrollment([
    criterion({
      criterionId: criterionIds.document,
      fieldName: "DOCUMENT_TYPE",
      operator: "REQUIRED",
      expectedValue: "VALID_ID",
    }),
  ], {
    documents: [
      { documentType: "VALID_ID", reviewStatus: "REJECTED" },
      { documentType: "VALID_ID", reviewStatus: "ACCEPTED", replacesDocumentId: "old" },
    ],
  }));
  assert.equal(accepted.overallStatus, "ELIGIBLE");
});

test("manual criteria require explicit decisions and required failures block", () => {
  const manualCriterion = criterion({
    criterionId: criterionIds.manual,
    criterionName: "Social worker assessment",
    fieldName: "MANUAL_REVIEW",
    operator: "REQUIRED",
    expectedValue: true,
  });

  assert.equal(
    evaluateEnrollmentEligibility(enrollment([manualCriterion])).overallStatus,
    "REVIEW_REQUIRED",
  );
  assert.equal(evaluateEnrollmentEligibility(enrollment([manualCriterion]), {
    manualDecisions: [{
      criterionId: criterionIds.manual,
      passed: true,
      remarks: "Assessment requirements were verified.",
    }],
  }).overallStatus, "ELIGIBLE");
  assert.equal(evaluateEnrollmentEligibility(enrollment([manualCriterion]), {
    manualDecisions: [{
      criterionId: criterionIds.manual,
      passed: false,
      remarks: "Assessment requirement was not met.",
    }],
  }).overallStatus, "INELIGIBLE");

  const optionalFailure = evaluateEnrollmentEligibility(enrollment([
    { ...manualCriterion, isRequired: false },
  ]), {
    manualDecisions: [{
      criterionId: criterionIds.manual,
      passed: false,
      remarks: "Advisory assessment was not met.",
    }],
  });
  assert.equal(optionalFailure.overallStatus, "ELIGIBLE");
  assert.equal(optionalFailure.results[0].blocking, false);
});

test("invalid or duplicate manual decisions are rejected", () => {
  const manualCriterion = criterion({
    criterionId: criterionIds.manual,
    fieldName: "MANUAL_REVIEW",
    operator: "REQUIRED",
    expectedValue: true,
  });
  const validDecision = {
    criterionId: criterionIds.manual,
    passed: true,
    remarks: "Verified by the reviewer.",
  };

  assert.throws(
    () => evaluateEnrollmentEligibility(enrollment([manualCriterion]), {
      manualDecisions: [validDecision, validDecision],
    }),
    (error) => error.code === "DUPLICATE_MANUAL_ELIGIBILITY_DECISION",
  );
  assert.throws(
    () => evaluateEnrollmentEligibility(enrollment([manualCriterion]), {
      manualDecisions: [{ ...validDecision, criterionId: criterionIds.age }],
    }),
    (error) => error.code === "INVALID_MANUAL_ELIGIBILITY_DECISION",
  );
  assert.throws(
    () => evaluateEnrollmentEligibility(enrollment([manualCriterion]), {
      manualDecisions: [{ ...validDecision, remarks: "no" }],
    }),
    (error) => error.code === "INVALID_MANUAL_ELIGIBILITY_DECISION",
  );
});

test("approval input requires one reasoned decision per manual criterion", () => {
  const valid = enrollmentApprovalSchema.parse({
    remarks: "Eligibility evidence reviewed.",
    manualDecisions: [{
      criterionId: criterionIds.manual,
      passed: true,
      remarks: "Home assessment evidence was verified.",
    }],
  });
  assert.equal(valid.manualDecisions.length, 1);
  assert.deepEqual(enrollmentApprovalSchema.parse({}), { manualDecisions: [] });
  assert.equal(enrollmentApprovalSchema.safeParse({
    manualDecisions: [
      valid.manualDecisions[0],
      { ...valid.manualDecisions[0], passed: false },
    ],
  }).success, false);
  assert.equal(enrollmentApprovalSchema.safeParse({
    manualDecisions: [{ ...valid.manualDecisions[0], remarks: "no" }],
  }).success, false);
});

test("malformed stored criteria fail closed", () => {
  assert.throws(
    () => evaluateEnrollmentEligibility(enrollment([
      criterion({ operator: "GREATER_THAN_OR_EQUAL", expectedValue: "adult" }),
    ])),
    (error) => error.code === "INVALID_PROGRAM_CRITERION" && error.statusCode === 409,
  );
});
