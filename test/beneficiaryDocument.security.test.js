import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  BENEFICIARY_DOCUMENT_READ_ROLES,
  BENEFICIARY_DOCUMENT_REPLACEMENT_ROLES,
  BENEFICIARY_DOCUMENT_REVIEW_ROLES,
  BENEFICIARY_DOCUMENT_UPLOAD_ROLES,
  assertBeneficiaryDocumentBarangayAccess,
  assertBeneficiaryDocumentReplacementAllowed,
  assertBeneficiaryDocumentReviewAllowed,
} from "../src/modules/documents/beneficiaryDocument.policy.js";
import {
  beneficiaryDocumentListParamsSchema,
  beneficiaryDocumentMetadataSchema,
  beneficiaryDocumentReviewSchema,
} from "../src/modules/documents/beneficiaryDocument.schemas.js";
import { detectAllowedDocumentMimeType } from "../src/modules/documents/beneficiaryDocument.file.js";
import {
  assertBeneficiaryDocumentReplacementTransition,
  assertBeneficiaryDocumentReviewTransition,
  beneficiaryDocumentSelect,
  resolveBeneficiaryDocumentPath,
} from "../src/modules/documents/beneficiaryDocument.service.js";
import { beneficiaryAccessScope } from "../src/modules/beneficiaries/beneficiary.policy.js";

const beneficiaryId = "11111111-1111-4111-8111-111111111111";
const otherBeneficiaryId = "22222222-2222-4222-8222-222222222222";
const barangayId = "33333333-3333-4333-8333-333333333333";
const otherBarangayId = "44444444-4444-4444-8444-444444444444";

test("only Barangay facilitators upload documents while all staff can read them", () => {
  assert.deepEqual(BENEFICIARY_DOCUMENT_UPLOAD_ROLES, ["BARANGAY_FACILITATOR"]);
  assert.deepEqual(BENEFICIARY_DOCUMENT_READ_ROLES, [
    "SYSTEM_ADMIN",
    "DSWD_STAFF",
    "BARANGAY_FACILITATOR",
  ]);
  assert.deepEqual(BENEFICIARY_DOCUMENT_REVIEW_ROLES, ["DSWD_STAFF"]);
  assert.deepEqual(BENEFICIARY_DOCUMENT_REPLACEMENT_ROLES, ["BARANGAY_FACILITATOR"]);
});

test("document review and replacement roles are also enforced in domain logic", () => {
  assert.doesNotThrow(() => assertBeneficiaryDocumentReviewAllowed({ role: "DSWD_STAFF" }));
  assert.throws(
    () => assertBeneficiaryDocumentReviewAllowed({ role: "SYSTEM_ADMIN" }),
    (error) => error.statusCode === 403 && error.code === "FORBIDDEN",
  );
  assert.doesNotThrow(() => assertBeneficiaryDocumentReplacementAllowed({
    role: "BARANGAY_FACILITATOR",
  }));
  assert.throws(
    () => assertBeneficiaryDocumentReplacementAllowed({ role: "DSWD_STAFF" }),
    (error) => error.statusCode === 403 && error.code === "FORBIDDEN",
  );
});

test("document metadata accepts only the approved controlled vocabulary", () => {
  assert.equal(beneficiaryDocumentMetadataSchema.parse({
    documentType: " valid_id ",
  }).documentType, "VALID_ID");
  assert.equal(beneficiaryDocumentMetadataSchema.safeParse({
    documentType: "PASSWORD_EXPORT",
  }).success, false);
  assert.equal(beneficiaryDocumentListParamsSchema.safeParse({ beneficiaryId }).success, true);
});

test("rejected document reviews require a meaningful reason", () => {
  assert.deepEqual(
    beneficiaryDocumentReviewSchema.parse({ decision: " accepted " }),
    { decision: "ACCEPTED" },
  );
  assert.equal(beneficiaryDocumentReviewSchema.safeParse({
    decision: "REJECTED",
  }).success, false);
  assert.equal(beneficiaryDocumentReviewSchema.safeParse({
    decision: "REJECTED",
    reason: "bad",
  }).success, false);
  assert.equal(beneficiaryDocumentReviewSchema.safeParse({
    decision: "REJECTED",
    reason: "The document is unreadable.",
  }).success, true);
});

test("only submitted documents can be accepted or rejected", () => {
  assert.doesNotThrow(() => assertBeneficiaryDocumentReviewTransition(
    { reviewStatus: "SUBMITTED" },
    "ACCEPTED",
  ));
  assert.doesNotThrow(() => assertBeneficiaryDocumentReviewTransition(
    { reviewStatus: "SUBMITTED" },
    "REJECTED",
  ));
  assert.throws(
    () => assertBeneficiaryDocumentReviewTransition(
      { reviewStatus: "ACCEPTED" },
      "REJECTED",
    ),
    (error) => error.code === "INVALID_DOCUMENT_REVIEW_TRANSITION",
  );
});

test("replacement requires the same beneficiary, type, and a rejected source", () => {
  const rejectedDocument = {
    beneficiaryId,
    documentType: "VALID_ID",
    reviewStatus: "REJECTED",
  };
  assert.doesNotThrow(() => assertBeneficiaryDocumentReplacementTransition(
    rejectedDocument,
    { beneficiaryId, documentType: "VALID_ID" },
  ));
  assert.throws(
    () => assertBeneficiaryDocumentReplacementTransition(
      { ...rejectedDocument, reviewStatus: "SUBMITTED" },
      { beneficiaryId, documentType: "VALID_ID" },
    ),
    (error) => error.code === "DOCUMENT_NOT_REPLACEABLE",
  );
  assert.throws(
    () => assertBeneficiaryDocumentReplacementTransition(
      rejectedDocument,
      { beneficiaryId: otherBeneficiaryId, documentType: "VALID_ID" },
    ),
    (error) => error.code === "DOCUMENT_BENEFICIARY_MISMATCH",
  );
  assert.throws(
    () => assertBeneficiaryDocumentReplacementTransition(
      rejectedDocument,
      { beneficiaryId, documentType: "BIRTH_CERTIFICATE" },
    ),
    (error) => error.code === "DOCUMENT_TYPE_MISMATCH",
  );
});

test("document operations use the facilitator's assigned barangay scope", () => {
  assert.deepEqual(beneficiaryAccessScope({
    role: "BARANGAY_FACILITATOR",
    barangayId,
  }), { barangayId });
  assert.doesNotThrow(() => assertBeneficiaryDocumentBarangayAccess({
    role: "BARANGAY_FACILITATOR",
    barangayId,
  }, barangayId));
  assert.throws(
    () => assertBeneficiaryDocumentBarangayAccess({
      role: "BARANGAY_FACILITATOR",
      barangayId,
    }, otherBarangayId),
    (error) => error.statusCode === 403 && error.code === "FORBIDDEN",
  );
});

test("document API metadata never exposes the server storage path", () => {
  assert.equal(Object.hasOwn(beneficiaryDocumentSelect, "filePath"), false);
  assert.equal(Object.hasOwn(beneficiaryDocumentSelect, "checksum"), true);
  assert.equal(Object.hasOwn(beneficiaryDocumentSelect, "reviewStatus"), true);
  assert.equal(Object.hasOwn(beneficiaryDocumentSelect, "replacesDocumentId"), true);
});

test("stored document paths cannot escape the dedicated upload directory", () => {
  const safePath = resolveBeneficiaryDocumentPath(
    "uploads/beneficiary-documents/11111111-1111-4111-8111-111111111111.pdf",
  );
  assert.equal(path.basename(safePath), "11111111-1111-4111-8111-111111111111.pdf");
  assert.throws(
    () => resolveBeneficiaryDocumentPath("uploads/beneficiary-documents/../../.env"),
    (error) => error.code === "INVALID_DOCUMENT_PATH",
  );
});

test("document type is detected from file bytes instead of an untrusted client MIME label", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const pdf = Buffer.from("%PDF-1.7\n", "ascii");

  assert.equal(detectAllowedDocumentMimeType(png), "image/png");
  assert.equal(detectAllowedDocumentMimeType(jpeg), "image/jpeg");
  assert.equal(detectAllowedDocumentMimeType(pdf), "application/pdf");
  assert.equal(detectAllowedDocumentMimeType(Buffer.from("not an allowed file")), null);
});
