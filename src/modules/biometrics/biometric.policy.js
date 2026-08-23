import { AppError } from "../../utils/AppError.js";

export const BIOMETRIC_READ_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "DSWD_STAFF",
  "BARANGAY_FACILITATOR",
]);

export const BIOMETRIC_CONSENT_MANAGE_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "DSWD_STAFF",
  "BARANGAY_FACILITATOR",
]);

export const BIOMETRIC_ENROLL_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "BARANGAY_FACILITATOR",
]);

export const BIOMETRIC_VERIFY_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "BARANGAY_FACILITATOR",
]);

export const BIOMETRIC_DELETE_ROLES = Object.freeze(["SYSTEM_ADMIN"]);

function assertRole(staffUser, roles, message) {
  if (!staffUser || !roles.includes(staffUser.role)) {
    throw new AppError(403, "FORBIDDEN", message);
  }
}

export function assertBiometricReadAllowed(staffUser) {
  assertRole(staffUser, BIOMETRIC_READ_ROLES, "You do not have permission to view biometric status metadata.");
}

export function assertBiometricConsentManageAllowed(staffUser) {
  assertRole(staffUser, BIOMETRIC_CONSENT_MANAGE_ROLES, "You do not have permission to manage biometric consent.");
}

export function assertBiometricEnrollAllowed(staffUser) {
  assertRole(staffUser, BIOMETRIC_ENROLL_ROLES, "Only System Administrators and assigned Barangay Facilitators may enroll biometrics.");
}

export function assertBiometricVerifyAllowed(staffUser) {
  assertRole(staffUser, BIOMETRIC_VERIFY_ROLES, "Only System Administrators and assigned Barangay Facilitators may verify biometric claims.");
}

export function assertBiometricDeleteAllowed(staffUser) {
  assertRole(staffUser, BIOMETRIC_DELETE_ROLES, "Only System Administrators may permanently delete biometric templates.");
}
