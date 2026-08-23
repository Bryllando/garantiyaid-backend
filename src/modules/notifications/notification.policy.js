import { AppError } from "../../utils/AppError.js";

export const NOTIFICATION_READ_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "DSWD_STAFF",
  "BARANGAY_FACILITATOR",
]);

export const NOTIFICATION_ENQUEUE_ROLES = NOTIFICATION_READ_ROLES;
export const NOTIFICATION_RETRY_ROLES = Object.freeze(["SYSTEM_ADMIN", "DSWD_STAFF"]);

export const FACILITATOR_NOTIFICATION_TYPES = Object.freeze([
  "SCHEDULE_CREATED",
  "SCHEDULE_UPDATED",
  "SCHEDULE_CANCELLED",
  "DISTRIBUTION_REMINDER",
]);

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

export function assertNotificationReadAllowed(staffUser) {
  if (!staffUser || !NOTIFICATION_READ_ROLES.includes(staffUser.role)) {
    throw new AppError(403, "FORBIDDEN", "You do not have permission to view notifications.");
  }
  if (staffUser.role === "BARANGAY_FACILITATOR") facilitatorBarangay(staffUser);
}

export function assertNotificationRetryAllowed(staffUser) {
  if (!staffUser || !NOTIFICATION_RETRY_ROLES.includes(staffUser.role)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only System Administrators and DSWD Staff may retry notifications.",
    );
  }
}

export function resolveNotificationBarangay(staffUser, requestedBarangayId) {
  if (staffUser?.role !== "BARANGAY_FACILITATOR") return requestedBarangayId;
  const assignedBarangayId = facilitatorBarangay(staffUser);
  if (requestedBarangayId && requestedBarangayId !== assignedBarangayId) {
    throw new AppError(403, "FORBIDDEN", "You can only access notifications in your assigned barangay.");
  }
  return assignedBarangayId;
}

export function assertNotificationBarangayAccess(staffUser, barangayId) {
  if (staffUser?.role !== "BARANGAY_FACILITATOR") return;
  if (facilitatorBarangay(staffUser) !== barangayId) {
    throw new AppError(403, "FORBIDDEN", "You can only access notifications in your assigned barangay.");
  }
}

export function assertNotificationTypeAllowed(staffUser, notificationType) {
  if (
    staffUser?.role === "BARANGAY_FACILITATOR"
    && !FACILITATOR_NOTIFICATION_TYPES.includes(notificationType)
  ) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Facilitators may enqueue only approved schedule and reminder notifications.",
    );
  }
}
