import test from "node:test";
import assert from "node:assert/strict";
import {
  createProgramCriterionSchema,
  createProgramSchema,
  programListQuerySchema,
  updateProgramSchema,
} from "../src/modules/programs/program.schemas.js";

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

test("program criteria accept JSON values but reject unknown fields and operators", () => {
  assert.equal(createProgramCriterionSchema.safeParse({
    criterionName: "At least 18 years old",
    fieldName: "age",
    operator: "greater_than_or_equal",
    expectedValue: 18,
  }).success, true);

  assert.equal(createProgramCriterionSchema.safeParse({
    criterionName: "Unsupported",
    fieldName: "PASSWORD_HASH",
    operator: "EQUALS",
    expectedValue: true,
  }).success, false);

  assert.equal(createProgramCriterionSchema.safeParse({
    criterionName: "Unsupported",
    fieldName: "AGE",
    operator: "EXECUTE",
    expectedValue: 18,
  }).success, false);
});

test("program list filters have safe pagination defaults", () => {
  assert.deepEqual(programListQuerySchema.parse({}), { page: 1, pageSize: 20 });
  assert.equal(programListQuerySchema.safeParse({ pageSize: 1000 }).success, false);
});
