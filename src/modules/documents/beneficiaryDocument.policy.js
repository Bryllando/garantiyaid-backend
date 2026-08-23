import { AppError } from "../../utils/AppError.js";

export const BENEFICIARY_DOCUMENT_READ_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "DSWD_STAFF",
  "BARANGAY_FACILITATOR",
]);

export const BENEFICIARY_DOCUMENT_UPLOAD_ROLES = Object.freeze([
  "BARANGAY_FACILITATOR",
]);

export const BENEFICIARY_DOCUMENT_REVIEW_ROLES = Object.freeze([
  "DSWD_STAFF",
]);

export const BENEFICIARY_DOCUMENT_REPLACEMENT_ROLES = Object.freeze([
  "BARANGAY_FACILITATOR",
]);

function assertRole(staffUser, allowedRoles, message) {
  if (!staffUser || !allowedRoles.includes(staffUser.role)) {
    throw new AppError(403, "FORBIDDEN", message);
  }
}

export function assertBeneficiaryDocumentUploadAllowed(staffUser) {
  assertRole(
    staffUser,
    BENEFICIARY_DOCUMENT_UPLOAD_ROLES,
    "Only Barangay Facilitators may upload beneficiary documents.",
  );
}

export function assertBeneficiaryDocumentReviewAllowed(staffUser) {
  assertRole(
    staffUser,
    BENEFICIARY_DOCUMENT_REVIEW_ROLES,
    "Only DSWD Staff may review beneficiary documents.",
  );
}

export function assertBeneficiaryDocumentReplacementAllowed(staffUser) {
  assertRole(
    staffUser,
    BENEFICIARY_DOCUMENT_REPLACEMENT_ROLES,
    "Only Barangay Facilitators may replace rejected beneficiary documents.",
  );
}

export function assertBeneficiaryDocumentBarangayAccess(staffUser, beneficiaryBarangayId) {
  if (staffUser?.role !== "BARANGAY_FACILITATOR") {
    return;
  }

  if (!staffUser.barangayId) {
    throw new AppError(
      403,
      "BARANGAY_ASSIGNMENT_REQUIRED",
      "This facilitator has no assigned barangay.",
    );
  }

  if (staffUser.barangayId !== beneficiaryBarangayId) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "You can only access beneficiary documents in your assigned barangay.",
    );
  }
}
