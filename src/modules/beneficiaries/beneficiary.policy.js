import { AppError } from "../../utils/AppError.js";

export const BENEFICIARY_READ_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "DSWD_STAFF",
  "BARANGAY_FACILITATOR",
]);

export const BENEFICIARY_CREATE_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "BARANGAY_FACILITATOR",
]);

export const BENEFICIARY_UPDATE_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "BARANGAY_FACILITATOR",
]);

export const BIOMETRIC_CONSENT_RECORD_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "DSWD_STAFF",
  "BARANGAY_FACILITATOR",
]);

function facilitatorBarangay(staffUser, requestedBarangayId) {
  if (!staffUser.barangayId) {
    throw new AppError(
      403,
      "BARANGAY_ASSIGNMENT_REQUIRED",
      "This facilitator has no assigned barangay.",
    );
  }

  if (requestedBarangayId && requestedBarangayId !== staffUser.barangayId) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "You can only access beneficiaries in your assigned barangay.",
    );
  }

  return staffUser.barangayId;
}

export function resolveBeneficiaryCreateBarangay(staffUser, requestedBarangayId) {
  if (staffUser.role === "BARANGAY_FACILITATOR") {
    return facilitatorBarangay(staffUser, requestedBarangayId);
  }

  if (!requestedBarangayId) {
    throw new AppError(
      400,
      "BARANGAY_ASSIGNMENT_REQUIRED",
      "A barangayId is required when creating a beneficiary.",
    );
  }

  return requestedBarangayId;
}

export function resolveBeneficiaryListBarangay(staffUser, requestedBarangayId) {
  if (staffUser.role === "BARANGAY_FACILITATOR") {
    return facilitatorBarangay(staffUser, requestedBarangayId);
  }

  return requestedBarangayId;
}

export function beneficiaryAccessScope(staffUser) {
  if (staffUser.role !== "BARANGAY_FACILITATOR") {
    return {};
  }

  return { barangayId: facilitatorBarangay(staffUser) };
}

export function assertBeneficiaryUpdateAllowed(staffUser, input) {
  if (staffUser.role === "SYSTEM_ADMIN") {
    return;
  }

  if (staffUser.role !== "BARANGAY_FACILITATOR") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "You do not have permission to update beneficiaries.",
    );
  }

  if (Object.hasOwn(input, "barangayId") || Object.hasOwn(input, "status")) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Facilitators cannot change a beneficiary's barangay or lifecycle status.",
    );
  }
}
