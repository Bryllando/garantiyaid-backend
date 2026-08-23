import test from "node:test";
import assert from "node:assert/strict";
import {
  ENROLLMENT_READ_ROLES,
  ENROLLMENT_REVIEW_ROLES,
  ENROLLMENT_SUBMIT_ROLES,
} from "../src/modules/enrollments/enrollment.policy.js";
import {
  assertEnrollmentStatus,
  assertProgramAcceptsEnrollment,
  assertRequiredDocuments,
  enrollmentAccessWhere,
} from "../src/modules/enrollments/enrollment.service.js";

const barangayId = "11111111-1111-4111-8111-111111111111";

test("Barangay submits, DSWD reviews, and all staff roles can read enrollments", () => {
  assert.deepEqual(ENROLLMENT_SUBMIT_ROLES, ["BARANGAY_FACILITATOR"]);
  assert.deepEqual(ENROLLMENT_REVIEW_ROLES, ["DSWD_STAFF"]);
  assert.deepEqual(ENROLLMENT_READ_ROLES, [
    "SYSTEM_ADMIN",
    "DSWD_STAFF",
    "BARANGAY_FACILITATOR",
  ]);
});

test("facilitator enrollment access is limited to the assigned barangay", () => {
  assert.deepEqual(enrollmentAccessWhere({
    role: "BARANGAY_FACILITATOR",
    barangayId,
  }), { beneficiary: { barangayId } });
  assert.deepEqual(enrollmentAccessWhere({ role: "DSWD_STAFF", barangayId: null }), {});
  assert.throws(
    () => enrollmentAccessWhere({ role: "BARANGAY_FACILITATOR", barangayId: null }),
    (error) => error.code === "BARANGAY_ASSIGNMENT_REQUIRED",
  );
});

test("submission fails when a program-required document is missing", () => {
  assert.doesNotThrow(() => assertRequiredDocuments(
    { requiredDocumentTypes: ["VALID_ID"] },
    [{ documentType: "VALID_ID", reviewStatus: "SUBMITTED" }],
  ));
  assert.throws(
    () => assertRequiredDocuments(
      { requiredDocumentTypes: ["VALID_ID", "BARANGAY_CERTIFICATE"] },
      [{ documentType: "VALID_ID", reviewStatus: "ACCEPTED" }],
    ),
    (error) => (
      error.code === "MISSING_REQUIRED_DOCUMENTS"
      && error.details.missingDocumentTypes[0] === "BARANGAY_CERTIFICATE"
    ),
  );
});

test("final approval requires an accepted current document for every required type", () => {
  const program = { requiredDocumentTypes: ["VALID_ID", "BARANGAY_CERTIFICATE"] };
  assert.doesNotThrow(() => assertRequiredDocuments(program, [
    { documentType: "VALID_ID", reviewStatus: "ACCEPTED" },
    { documentType: "BARANGAY_CERTIFICATE", reviewStatus: "ACCEPTED" },
  ], { acceptedOnly: true }));
  assert.throws(
    () => assertRequiredDocuments(program, [
      { documentType: "VALID_ID", reviewStatus: "SUBMITTED" },
      { documentType: "BARANGAY_CERTIFICATE", reviewStatus: "REJECTED" },
    ], { acceptedOnly: true }),
    (error) => (
      error.code === "REQUIRED_DOCUMENTS_NOT_ACCEPTED"
      && error.details.unacceptedDocumentTypes.length === 2
    ),
  );
  assert.throws(
    () => assertRequiredDocuments(
      { requiredDocumentTypes: ["VALID_ID"] },
      [{ documentType: "VALID_ID", reviewStatus: "SUPERSEDED" }],
    ),
    (error) => error.code === "MISSING_REQUIRED_DOCUMENTS",
  );
});

test("only active programs inside the application period accept submissions", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  assert.doesNotThrow(() => assertProgramAcceptsEnrollment({
    status: "ACTIVE",
    applicationStartDate: new Date("2026-08-01T00:00:00.000Z"),
    applicationEndDate: new Date("2026-08-31T00:00:00.000Z"),
  }, now));
  assert.throws(
    () => assertProgramAcceptsEnrollment({ status: "DRAFT" }, now),
    (error) => error.code === "PROGRAM_NOT_ACCEPTING_ENROLLMENTS",
  );
  assert.throws(
    () => assertProgramAcceptsEnrollment({
      status: "ACTIVE",
      applicationEndDate: new Date("2026-08-09T00:00:00.000Z"),
    }, now),
    (error) => error.code === "PROGRAM_APPLICATION_CLOSED",
  );
});

test("enrollment state actions cannot skip the review flow", () => {
  assert.doesNotThrow(() => assertEnrollmentStatus(
    { status: "PENDING" },
    ["PENDING"],
    "ENROLLMENT_REVIEW_STARTED",
  ));
  assert.throws(
    () => assertEnrollmentStatus(
      { status: "PENDING" },
      ["FOR_VALIDATION"],
      "ENROLLMENT_APPROVED",
    ),
    (error) => error.code === "INVALID_ENROLLMENT_TRANSITION",
  );
});
