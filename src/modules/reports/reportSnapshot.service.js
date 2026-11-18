import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { assertDetailedReportAllowed } from "../dashboard/dashboard.policy.js";
import { getDashboardDistributionOrThrow } from "../dashboard/dashboard.service.js";
import { distributionToResponse } from "../distributions/distribution.service.js";
import { generateAnomalyReport, generateClaimStatusReport, generateDistributionSummaryReport, generateFundUtilizationReport, generateQueueScheduleReport } from "./report.service.js";

const rowKeys = { CLAIMS: "claims", SCHEDULES: "schedules", ANOMALIES: "anomalies", FUNDS: "distributions" };

export async function collectReportPages(readPage, rowKey) {
  let report = await readPage(1, 100);
  const { total } = report.data.pagination;
  if (report.data[rowKey].length < total) report = await readPage(1, total);
  const rows = report.data[rowKey];
  if (report.data.pagination.total !== total || rows.length !== total) throw new AppError(409, "REPORT_INCOMPLETE", "The complete report could not be assembled. Generate it again.");
  return { ...report, data: { ...report.data, [rowKey]: rows, pagination: { page: 1, pageSize: Math.max(total, 1), total, totalPages: total ? 1 : 0 } } };
}

export async function generateReportSnapshot({ scope, filters }, staffUser, database = prisma) {
  assertDetailedReportAllowed(staffUser);
  return database.$transaction(async transaction => {
    const generatedAt = new Date().toISOString();
    const event = scope.distributionId ? distributionToResponse(await getDashboardDistributionOrThrow(scope.distributionId, staffUser, transaction)) : null;
    const readComplete = async (type, activeFilters) => {
      const readPage = (page, pageSize) => {
        const pagination = { ...activeFilters, page, pageSize };
        if (type === "CLAIMS") return generateClaimStatusReport(scope.distributionId, staffUser, pagination, transaction);
        if (type === "SCHEDULES") return generateQueueScheduleReport(scope.distributionId, staffUser, pagination, transaction);
        if (type === "ANOMALIES") return generateAnomalyReport(scope.distributionId, staffUser, pagination, transaction);
        return generateFundUtilizationReport({ ...pagination, distributionId: scope.distributionId }, staffUser, transaction);
      };
      const report = await collectReportPages(readPage, rowKeys[type]);
      return { ...report, generatedAt, timeZone: "Asia/Manila" };
    };
    if (scope.type !== "SUMMARY") return { ...await readComplete(scope.type, filters), snapshotComplete: true, coverage: scope, event };
    const report = await generateDistributionSummaryReport(scope.distributionId, staffUser, transaction);
    const supportingReports = {};
    for (const type of ["CLAIMS", "SCHEDULES", "ANOMALIES", "FUNDS"]) supportingReports[type] = await readComplete(type, {});
    return { ...report, generatedAt, snapshotComplete: true, coverage: scope, event, supportingReports };
  }, { isolationLevel: "RepeatableRead", timeout: 60_000 });
}

export function reportFacts(report) {
  const { data, coverage } = report;
  const count = value => value == null ? "Unavailable" : Number(value).toLocaleString("en-PH");
  const fact = (id, label, explanation) => ({ id, label, explanation });
  if (coverage.type === "SUMMARY") {
    const beneficiaries = data.beneficiaries;
    const allocations = Object.entries(beneficiaries.allocationStatusCounts ?? {}).filter(([status]) => status !== "CANCELLED").reduce((total, [, value]) => total + value, 0);
    return [
      fact("completion", "Assistance completion", `${count(beneficiaries.claimedCount)} claims are recorded as claimed. Completion is ${beneficiaries.claimCompletionPercentage}% of ${count(allocations)} non-cancelled allocations.`),
      fact("awaiting", "Pending assistance", `${count(beneficiaries.verifiedCount)} claims are verified and awaiting assistance. ${count(beneficiaries.unclaimedCount)} allocations remain pending or allocated.`),
      fact("attendance", "Attendance", `${count(beneficiaries.checkedInCount)} schedules are checked in. Attendance and identity checks are stages before a recorded handover or wallet credit.`),
      fact("capacity", "Queue capacity", `${count(data.slots.activeQueueCount)} active queue entries use ${count(data.slots.totalCapacity)} available places (${data.slots.capacityUtilizationPercentage}%).`),
      fact("exceptions", "Exceptions for review", `${count(report.supportingReports.ANOMALIES.data.summary.total)} exception records cover QR attempts, face checks, duplicate flags, and transaction exceptions. Review individual records because retries and reversals may also appear.`),
      fact("delivery", "Delivery and accountability", data.distribution.deliveryMode === "PHYSICAL_GOODS" ? "Barangay staff record physical handovers. Recorded package quantities include voided claims, and a void does not record returned goods." : "DSWD records simulated wallet credits. Amounts describe the internal prototype ledger and no real funds are transferred."),
    ];
  }
  if (coverage.type === "CLAIMS") return [
    fact("matching", "Matching records", `${count(data.summary.matchingClaimCount)} claims match the selected dates and status. Dates use claim creation in Philippine time.`),
    fact("completed", "Recorded assistance", `${count(data.summary.statusCounts.CLAIMED ?? 0)} claims have CLAIMED status within the date range, across all statuses. Physical release and simulated wallet credit follow the event's delivery mode.`),
    fact("verified", "Awaiting assistance", `${count(data.summary.statusCounts.VERIFIED ?? 0)} claims have VERIFIED status within the date range. Record the required release or credit to complete assistance.`),
    fact("coverage", "Status coverage", "Status totals cover all statuses within the selected dates. The detailed records follow the selected status filter."),
  ];
  if (coverage.type === "SCHEDULES") return [
    fact("matching", "Matching records", `${count(data.summary.matchingScheduleCount)} schedules match the selected dates and status. Dates refer to schedule record creation, rather than the appointment date.`),
    fact("attendance", "Attendance", `${count(data.summary.statusCounts.CHECKED_IN ?? 0)} schedules are checked in across the date range. Attendance alone is a separate stage from assistance release.`),
    fact("missed", "Follow-up", `${count(data.summary.statusCounts.MISSED ?? 0)} schedules are marked missed across the date range. Review appointments and the event's permitted recovery actions.`),
    fact("coverage", "Status coverage", "Status totals cover all statuses within the selected dates. The detailed records follow the selected status filter."),
  ];
  if (coverage.type === "ANOMALIES") return [
    fact("matching", "Exception records", `${count(data.summary.total)} exception records match the selected occurrence dates.`),
    fact("categories", "Exception categories", `The records include ${count(data.summary.qrAnomalyCount)} QR exceptions, ${count(data.summary.biometricAnomalyCount)} biometric exceptions, ${count(data.summary.duplicateClaimFlagCount)} duplicate-claim flags, and ${count(data.summary.transactionAnomalyCount)} transaction exceptions.`),
    fact("review", "How to review", "An exception record may describe a retry, failed check, duplicate flag, or reversal. Review its reference and outcome before deciding on follow-up."),
  ];
  return [
    fact("coverage", "Financial coverage", `${count(data.pagination.total)} distribution events match the selected event dates and status. Totals include every matching event.`),
    fact("funds", "Simulated fund utilization", `Allocated PHP ${data.totals.allocatedAmount}; net credited PHP ${data.totals.netCreditedAmount}; remaining PHP ${data.totals.remainingAmount}. Net credit accounts for completed reversals.`),
    fact("simulation", "Simulation disclosure", "These amounts describe the internal prototype ledger. No real funds are transferred."),
  ];
}
