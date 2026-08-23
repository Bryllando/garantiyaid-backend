import { AppError } from "../../utils/AppError.js";
import { resolveDistributionListBarangay } from "../distributions/distribution.policy.js";

export const DASHBOARD_READ_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "DSWD_STAFF",
  "BARANGAY_FACILITATOR",
]);

export const DISTRIBUTION_SUMMARY_REPORT_ROLES = DASHBOARD_READ_ROLES;

export const DETAILED_REPORT_ROLES = Object.freeze([
  "SYSTEM_ADMIN",
  "DSWD_STAFF",
]);

export const FUND_REPORT_ROLES = DETAILED_REPORT_ROLES;

export function assertDashboardReadAllowed(staffUser) {
  if (!staffUser || !DASHBOARD_READ_ROLES.includes(staffUser.role)) {
    throw new AppError(403, "FORBIDDEN", "You do not have permission to view dashboard metrics.");
  }
}

export function assertDistributionSummaryReportAllowed(staffUser) {
  if (!staffUser || !DISTRIBUTION_SUMMARY_REPORT_ROLES.includes(staffUser.role)) {
    throw new AppError(403, "FORBIDDEN", "You do not have permission to generate distribution summaries.");
  }
}

export function assertDetailedReportAllowed(staffUser) {
  if (!staffUser || !DETAILED_REPORT_ROLES.includes(staffUser.role)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only System Administrators and DSWD Staff may generate detailed reports and exports.",
    );
  }
}

export function assertFundReportAllowed(staffUser) {
  if (!staffUser || !FUND_REPORT_ROLES.includes(staffUser.role)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only System Administrators and DSWD Staff may view global simulated fund utilization.",
    );
  }
}

export function resolveDashboardBarangay(staffUser, requestedBarangayId) {
  return resolveDistributionListBarangay(staffUser, requestedBarangayId);
}

export function canViewGlobalFinancialMetrics(staffUser) {
  return FUND_REPORT_ROLES.includes(staffUser?.role);
}
