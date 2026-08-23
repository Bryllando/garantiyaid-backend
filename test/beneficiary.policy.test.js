import test from "node:test";
import assert from "node:assert/strict";
import {
  BENEFICIARY_CREATE_ROLES,
  BENEFICIARY_READ_ROLES,
  BENEFICIARY_UPDATE_ROLES,
  BIOMETRIC_CONSENT_RECORD_ROLES,
  assertBeneficiaryUpdateAllowed,
  beneficiaryAccessScope,
  resolveBeneficiaryCreateBarangay,
  resolveBeneficiaryListBarangay,
} from "../src/modules/beneficiaries/beneficiary.policy.js";

const barangayId = "11111111-1111-4111-8111-111111111111";
const otherBarangayId = "22222222-2222-4222-8222-222222222222";

test("beneficiary route policies match the approved staff-web RBAC", () => {
  assert.deepEqual(BENEFICIARY_READ_ROLES, [
    "SYSTEM_ADMIN",
    "DSWD_STAFF",
    "BARANGAY_FACILITATOR",
  ]);
  assert.deepEqual(BENEFICIARY_CREATE_ROLES, [
    "SYSTEM_ADMIN",
    "BARANGAY_FACILITATOR",
  ]);
  assert.deepEqual(BENEFICIARY_UPDATE_ROLES, [
    "SYSTEM_ADMIN",
    "BARANGAY_FACILITATOR",
  ]);
  assert.deepEqual(BIOMETRIC_CONSENT_RECORD_ROLES, [
    "SYSTEM_ADMIN",
    "DSWD_STAFF",
    "BARANGAY_FACILITATOR",
  ]);
});

test("facilitator beneficiary creation derives the authenticated barangay", () => {
  const facilitator = { role: "BARANGAY_FACILITATOR", barangayId };

  assert.equal(resolveBeneficiaryCreateBarangay(facilitator), barangayId);
  assert.equal(resolveBeneficiaryCreateBarangay(facilitator, barangayId), barangayId);
  assert.throws(
    () => resolveBeneficiaryCreateBarangay(facilitator, otherBarangayId),
    (error) => error.statusCode === 403 && error.code === "FORBIDDEN",
  );
});

test("facilitator access requires a real barangay assignment", () => {
  const facilitator = { role: "BARANGAY_FACILITATOR", barangayId: null };

  assert.throws(
    () => beneficiaryAccessScope(facilitator),
    (error) => error.statusCode === 403 && error.code === "BARANGAY_ASSIGNMENT_REQUIRED",
  );
});

test("system administrator must submit a barangay when creating a beneficiary", () => {
  const administrator = { role: "SYSTEM_ADMIN", barangayId: null };

  assert.equal(resolveBeneficiaryCreateBarangay(administrator, barangayId), barangayId);
  assert.throws(
    () => resolveBeneficiaryCreateBarangay(administrator),
    (error) => error.statusCode === 400 && error.code === "BARANGAY_ASSIGNMENT_REQUIRED",
  );
});

test("DSWD list access remains global unless a barangay filter is supplied", () => {
  const dswd = { role: "DSWD_STAFF", barangayId: null };

  assert.equal(resolveBeneficiaryListBarangay(dswd), undefined);
  assert.equal(resolveBeneficiaryListBarangay(dswd, barangayId), barangayId);
});

test("facilitators can edit profile data but cannot transfer or change status", () => {
  const facilitator = { role: "BARANGAY_FACILITATOR", barangayId };

  assert.doesNotThrow(() => assertBeneficiaryUpdateAllowed(facilitator, {
    contactNumber: "+639171234567",
  }));
  assert.throws(
    () => assertBeneficiaryUpdateAllowed(facilitator, { barangayId: otherBarangayId }),
    (error) => error.statusCode === 403 && error.code === "FORBIDDEN",
  );
  assert.throws(
    () => assertBeneficiaryUpdateAllowed(facilitator, { status: "SUSPENDED" }),
    (error) => error.statusCode === 403 && error.code === "FORBIDDEN",
  );
});

test("DSWD update is denied as defense in depth", () => {
  assert.throws(
    () => assertBeneficiaryUpdateAllowed(
      { role: "DSWD_STAFF", barangayId: null },
      { firstName: "Updated" },
    ),
    (error) => error.statusCode === 403 && error.code === "FORBIDDEN",
  );
});
