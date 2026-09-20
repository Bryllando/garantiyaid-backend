import test from "node:test";
import assert from "node:assert/strict";
import {
  createProgramCriterionSchema,
  createProgramSchema,
  programListQuerySchema,
  updateProgramSchema,
} from "../src/modules/programs/program.schemas.js";
import {
  assertProgramCriteriaValid,
  assertProgramCriterionValid,
} from "../src/modules/programs/program.service.js";

test("program creation normalizes dates, amounts, codes, and required documents", () => {
  const program = createProgramSchema.parse({
    programName: "Educational Assistance",
    programCode: " educ-2026 ",
    programType: " educational ",
    grantAmount: "5000.00",
    budgetAmount: "500000",
    applicationStartDate: "2026-08-10",
    applicationEndDate: "2026-09-10",
    requiredDocumentTypes: ["VALID_ID", "VALID_ID", "BARANGAY_CERTIFICATE"],
  });

  assert.equal(program.programCode, "EDUC-2026");
  assert.equal(program.programType, "EDUCATIONAL");
  assert.equal(program.grantAmount, 5000);
  assert.equal(program.applicationStartDate.toISOString(), "2026-08-10T00:00:00.000Z");
  assert.deepEqual(program.requiredDocumentTypes, ["VALID_ID", "BARANGAY_CERTIFICATE"]);
});

test("program input rejects malformed codes, dates, and unapproved document types", () => {
  assert.equal(createProgramSchema.safeParse({
    programName: "Test",
    programCode: "bad code",
    programType: "TEST",
  }).success, false);

  assert.equal(createProgramSchema.safeParse({
    programName: "Test",
    programCode: "TEST-01",
    programType: "TEST",
    applicationStartDate: "2026-02-30",
  }).success, false);

  assert.equal(createProgramSchema.safeParse({
    programName: "Test",
    programCode: "TEST-01",
    programType: "TEST",
    requiredDocumentTypes: ["PASSWORD_SCREENSHOT"],
  }).success, false);
});

test("program updates require at least one approved field", () => {
  assert.equal(updateProgramSchema.safeParse({}).success, false);
  assert.equal(updateProgramSchema.safeParse({ status: "ACTIVE" }).success, false);
  assert.equal(updateProgramSchema.safeParse({ description: "Updated requirements" }).success, true);
});

test("program criteria enforce field, operator, and value compatibility", () => {
  const valid = [
    ["AGE", "GREATER_THAN_OR_EQUAL", 18],
    ["AGE", "IN", [18, 21]],
    ["SEX", "EQUALS", " female "],
    ["SEX", "NOT_IN", ["MALE", "UNKNOWN"]],
    ["BARANGAY_ID", "EQUALS", "11111111-1111-4111-8111-111111111111"],
    ["DOCUMENT_TYPE", "REQUIRED", " valid_id "],
    ["MANUAL_REVIEW", "REQUIRED", true],
  ];
  valid.forEach(([fieldName, operator, expectedValue]) => {
    assert.equal(createProgramCriterionSchema.safeParse({
      criterionName: "Valid rule",
      fieldName,
      operator,
      expectedValue,
    }).success, true, `${fieldName} ${operator} should be valid`);
  });

  const invalid = [
    ["AGE", "GREATER_THAN_OR_EQUAL", "adult"],
    ["AGE", "IN", [18, 18]],
    ["SEX", "GREATER_THAN", "FEMALE"],
    ["SEX", "EQUALS", "UNLISTED"],
    ["BARANGAY_ID", "EQUALS", "not-a-uuid"],
    ["DOCUMENT_TYPE", "EQUALS", "VALID_ID"],
    ["DOCUMENT_TYPE", "REQUIRED", "PASSWORD_SCREENSHOT"],
    ["MANUAL_REVIEW", "REQUIRED", false],
    ["MANUAL_REVIEW", "EQUALS", true],
  ];
  invalid.forEach(([fieldName, operator, expectedValue]) => {
    assert.equal(createProgramCriterionSchema.safeParse({
      criterionName: "Invalid rule",
      fieldName,
      operator,
      expectedValue,
    }).success, false, `${fieldName} ${operator} should be invalid`);
  });

  assert.equal(createProgramCriterionSchema.safeParse({
    criterionName: "Unsupported",
    fieldName: "PASSWORD_HASH",
    operator: "EQUALS",
    expectedValue: true,
  }).success, false);
});

test("partial criterion updates are validated after merging with the stored rule", () => {
  const existing = {
    criterionName: "Adult beneficiary",
    fieldName: "AGE",
    operator: "GREATER_THAN_OR_EQUAL",
    expectedValue: 18,
    isRequired: true,
  };
  assert.equal(assertProgramCriterionValid({ ...existing, expectedValue: 21 }).expectedValue, 21);
  assert.throws(
    () => assertProgramCriterionValid({ ...existing, operator: "REQUIRED" }),
    (error) => error.code === "INVALID_PROGRAM_CRITERION" && error.statusCode === 400,
  );
});

test("Barangay criteria must reference active Barangay records", async () => {
  const storedBarangayId = "11111111-1111-4111-8111-111111111111";
  const criterion = {
    criterionName: "Covered Barangay",
    fieldName: "BARANGAY_ID",
    operator: "EQUALS",
    expectedValue: storedBarangayId,
    isRequired: true,
  };
  const activeDatabase = {
    barangay: { findMany: async () => [{ barangayId: storedBarangayId }] },
  };
  assert.equal((await assertProgramCriteriaValid([criterion], activeDatabase))[0].expectedValue, storedBarangayId);
  await assert.rejects(
    () => assertProgramCriteriaValid([criterion], {
      barangay: { findMany: async () => [] },
    }),
    (error) => error.code === "INVALID_CRITERION_BARANGAY" && error.statusCode === 400,
  );
});

test("program list filters have safe pagination defaults", () => {
  assert.deepEqual(programListQuerySchema.parse({}), { page: 1, pageSize: 20 });
  assert.equal(programListQuerySchema.safeParse({ pageSize: 1000 }).success, false);
});
