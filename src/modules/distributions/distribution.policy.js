import { AppError } from "../../utils/AppError.js";

export const DISTRIBUTION_READ_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "DSWD_STAFF",
  "BARANGAY_FACILITATOR",
]);

export const DISTRIBUTION_MANAGE_ROLES = Object.freeze(["SYSTEM_ADMIN"]);

export const DISTRIBUTION_SCHEDULE_MANAGE_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "BARANGAY_FACILITATOR",
]);

export const QR_TOKEN_MANAGE_ROLES = Object.freeze(["SYSTEM_ADMIN"]);

export const CLAIM_VERIFY_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "BARANGAY_FACILITATOR",
]);

export const PHYSICAL_RELEASE_ROLES = Object.freeze(["BARANGAY_FACILITATOR"]);

export const CLAIM_DISPUTE_FILE_ROLES = DISTRIBUTION_READ_ROLES;

export const CLAIM_DISPUTE_REVIEW_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "DSWD_STAFF",
]);

export const WALLET_READ_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "DSWD_STAFF",
]);

export const WALLET_MANAGE_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "DSWD_STAFF",
]);

export function assertDistributionReadAllowed(staffUser) {
  if (!staffUser || !DISTRIBUTION_READ_ROLES.includes(staffUser.role)) {
    throw new AppError(403, "FORBIDDEN", "You do not have permission to view distribution events.");
  }
}

export function assertDistributionManageAllowed(staffUser) {
  if (!staffUser || !DISTRIBUTION_MANAGE_ROLES.includes(staffUser.role)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only System Administrators may manage distribution events.",
    );
  }
}

export function assertDistributionScheduleManageAllowed(staffUser) {
  if (!staffUser || !DISTRIBUTION_SCHEDULE_MANAGE_ROLES.includes(staffUser.role)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only System Administrators and assigned Barangay Facilitators may manage schedules.",
    );
  }
}

export function assertQrTokenManageAllowed(staffUser) {
  if (!staffUser || !QR_TOKEN_MANAGE_ROLES.includes(staffUser.role)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only System Administrators may generate, revoke, or reissue QR tokens.",
    );
  }
}

export function assertClaimVerifyAllowed(staffUser) {
  if (!staffUser || !CLAIM_VERIFY_ROLES.includes(staffUser.role)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only System Administrators and assigned Barangay Facilitators may verify QR claims.",
    );
  }
}

export function assertPhysicalReleaseAllowed(staffUser) {
  if (!staffUser || !PHYSICAL_RELEASE_ROLES.includes(staffUser.role)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only the assigned Barangay Facilitator may record a physical assistance release.",
    );
  }
}

export function assertClaimDisputeFileAllowed(staffUser) {
  if (!staffUser || !CLAIM_DISPUTE_FILE_ROLES.includes(staffUser.role)) {
    throw new AppError(403, "FORBIDDEN", "You do not have permission to file a claim dispute.");
  }
}

export function assertClaimDisputeReviewAllowed(staffUser) {
  if (!staffUser || !CLAIM_DISPUTE_REVIEW_ROLES.includes(staffUser.role)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only System Administrators and DSWD Staff may review claim disputes.",
    );
  }
}

export function assertWalletReadAllowed(staffUser) {
  if (!staffUser || !WALLET_READ_ROLES.includes(staffUser.role)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only System Administrators and DSWD Staff may view simulated wallets and ledger records.",
    );
  }
}

export function assertWalletManageAllowed(staffUser) {
  if (!staffUser || !WALLET_MANAGE_ROLES.includes(staffUser.role)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only System Administrators and DSWD Staff may manage simulated wallet transactions.",
    );
  }
}

function facilitatorBarangay(staffUser) {
  if (!staffUser?.barangayId) {
    throw new AppError(
      403,
      "BARANGAY_ASSIGNMENT_REQUIRED",
      "This facilitator has no assigned barangay.",
    );
  }

  return staffUser.barangayId;
}

export function resolveDistributionListBarangay(staffUser, requestedBarangayId) {
  if (staffUser?.role !== "BARANGAY_FACILITATOR") {
    return requestedBarangayId;
  }

  const assignedBarangayId = facilitatorBarangay(staffUser);
  if (requestedBarangayId && requestedBarangayId !== assignedBarangayId) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "You can only view distribution events in your assigned barangay.",
    );
  }

  return assignedBarangayId;
}

export function distributionAccessWhere(staffUser) {
  if (staffUser?.role !== "BARANGAY_FACILITATOR") {
    return {};
  }

  return { barangayId: facilitatorBarangay(staffUser) };
}
