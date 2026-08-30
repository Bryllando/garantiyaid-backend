import test from "node:test";
import assert from "node:assert/strict";
import {
  beneficiaryListQuerySchema,
  createBeneficiarySchema,
  createBiometricConsentSchema,
  updateBeneficiarySchema,
} from "../src/modules/beneficiaries/beneficiary.schemas.js";

const barangayId = "11111111-1111-4111-8111-111111111111";

function validBeneficiary(overrides = {}) {
  return {
    firstName: "Juan",
    lastName: "Dela Cruz",
    birthDate: "1990-05-20",
    sex: "male",
    address: "Cebu City",
    sitioPurok: "Sitio Riverside",
    barangayId,
    ...overrides,
  };
}

test("create beneficiary normalizes the staff-web input contract", () => {
  const result = createBeneficiarySchema.parse(validBeneficiary({
    middleName: "",
    contactNumber: "0917 123 4567",
    email: " JUAN@EXAMPLE.COM ",
    philsysNumber: "",
  }));

  assert.equal(result.sex, "MALE");
  assert.equal(result.birthDate.toISOString(), "1990-05-20T00:00:00.000Z");
  assert.equal(result.middleName, null);
  assert.equal(result.contactNumber, "+639171234567");
  assert.equal(result.email, "juan@example.com");
  assert.equal(result.philsysNumber, null);
  assert.equal(result.sitioPurok, "Sitio Riverside");
});

test("facilitator payload may omit barangayId so the server can derive it", () => {
  const { barangayId: ignored, ...payload } = validBeneficiary();
  assert.equal(createBeneficiarySchema.safeParse(payload).success, true);
});

test("birth date must be a real non-future YYYY-MM-DD string", () => {
  assert.equal(createBeneficiarySchema.safeParse(validBeneficiary({ birthDate: "1990-02-30" })).success, false);
  assert.equal(createBeneficiarySchema.safeParse(validBeneficiary({ birthDate: 631152000000 })).success, false);
  assert.equal(createBeneficiarySchema.safeParse(validBeneficiary({ birthDate: "2999-01-01" })).success, false);
});

test("sex values fit the approved database field", () => {
  assert.equal(createBeneficiarySchema.safeParse(validBeneficiary({ sex: "unknown" })).success, true);
  assert.equal(createBeneficiarySchema.safeParse(validBeneficiary({ sex: "NOT_SPECIFIED" })).success, false);
});

test("contact number accepts Philippine mobile forms and rejects invalid values", () => {
  const local = createBeneficiarySchema.parse(validBeneficiary({ contactNumber: "09171234567" }));
  const international = createBeneficiarySchema.parse(validBeneficiary({ contactNumber: "+639171234567" }));

  assert.equal(local.contactNumber, "+639171234567");
  assert.equal(international.contactNumber, "+639171234567");
  assert.equal(createBeneficiarySchema.safeParse(validBeneficiary({ contactNumber: "12345" })).success, false);
});

test("beneficiary isVerified is excluded from the staff-web update contract", () => {
  const result = updateBeneficiarySchema.safeParse({ isVerified: true });
  assert.equal(result.success, false);
});

test("nullable beneficiary fields can be intentionally cleared", () => {
  const result = updateBeneficiarySchema.parse({
    middleName: "",
    contactNumber: null,
    email: "",
    philsysNumber: null,
    sitioPurok: "",
  });

  assert.deepEqual(result, {
    middleName: null,
    contactNumber: null,
    email: null,
    philsysNumber: null,
    sitioPurok: null,
  });
});

test("lifecycle status is normalized and unknown JSON fields are rejected", () => {
  assert.equal(updateBeneficiarySchema.parse({ status: "suspended" }).status, "SUSPENDED");
  assert.equal(updateBeneficiarySchema.safeParse({ mobileAccessToken: "not-allowed" }).success, false);
});

test("beneficiary list query applies defaults and rejects unknown filters", () => {
  assert.deepEqual(beneficiaryListQuerySchema.parse({}), {
    page: 1,
    pageSize: 20,
  });
  assert.equal(beneficiaryListQuerySchema.safeParse({ mobileUserId: "x" }).success, false);
});

test("biometric consent accepts only a future ISO datetime with timezone", () => {
  const retentionUntil = new Date(Date.now() + 86_400_000).toISOString();
  const result = createBiometricConsentSchema.parse({
    consentVersion: "v1.0",
    consentGiven: true,
    retentionUntil,
  });

  assert.equal(result.retentionUntil.toISOString(), retentionUntil);
  assert.equal(createBiometricConsentSchema.safeParse({
    consentVersion: "v1.0",
    consentGiven: true,
    retentionUntil: "tomorrow",
  }).success, false);
});
