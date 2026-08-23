import { writeAuditLog } from "../audit/audit.service.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  assertDetailedReportAllowed,
  assertDistributionSummaryReportAllowed,
  assertFundReportAllowed,
} from "../dashboard/dashboard.policy.js";
import {
  generateAnomalyReport,
  generateClaimStatusReport,
  generateDistributionCsvExport,
  generateDistributionSummaryReport,
  generateFundUtilizationReport,
  generateQueueScheduleReport,
} from "./report.service.js";

export function buildReportAuditLog(req, {
  action,
  reportType,
  distributionId = null,
  format = "JSON",
  rowCount,
}) {
  return {
    userId: req.auth.userId,
    action,
    entityAffected: "REPORT",
    recordId: distributionId,
    ipAddress: clientIpAddress(req),
    details: {
      reportType,
      format,
      distributionId,
      ...(Number.isInteger(rowCount) ? { rowCount } : {}),
      prototypeComplianceReview: true,
      coaCertified: false,
    },
  };
}

async function recordReportAction(req, options) {
  await writeAuditLog(buildReportAuditLog(req, options));
}

export function applyCsvDownloadHeaders(res, filename) {
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${filename}"`);
  res.set("X-Report-Prototype", "true");
  res.set("X-COA-Certified", "false");
}

export const getDistributionSummaryReport = asyncHandler(async (req, res) => {
  assertDistributionSummaryReportAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const report = await generateDistributionSummaryReport(distributionId, req.staffUser);
  await recordReportAction(req, {
    action: "DISTRIBUTION_SUMMARY_REPORT_GENERATED",
    reportType: "DISTRIBUTION_SUMMARY",
    distributionId,
  });
  return res.status(200).json({ success: true, data: { report } });
});

export const getClaimStatusReport = asyncHandler(async (req, res) => {
  assertDetailedReportAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const report = await generateClaimStatusReport(
    distributionId,
    req.staffUser,
    req.validatedQuery,
  );
  await recordReportAction(req, {
    action: "CLAIM_STATUS_REPORT_GENERATED",
    reportType: "CLAIM_STATUS",
    distributionId,
    rowCount: report.data.claims.length,
  });
  return res.status(200).json({ success: true, data: { report } });
});

export const getQueueScheduleReport = asyncHandler(async (req, res) => {
  assertDetailedReportAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const report = await generateQueueScheduleReport(
    distributionId,
    req.staffUser,
    req.validatedQuery,
  );
  await recordReportAction(req, {
    action: "QUEUE_SCHEDULE_REPORT_GENERATED",
    reportType: "QUEUE_SCHEDULE",
    distributionId,
    rowCount: report.data.schedules.length,
  });
  return res.status(200).json({ success: true, data: { report } });
});

export const getAnomalyReport = asyncHandler(async (req, res) => {
  assertDetailedReportAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const report = await generateAnomalyReport(
    distributionId,
    req.staffUser,
    req.validatedQuery,
  );
  await recordReportAction(req, {
    action: "ANOMALY_REPORT_GENERATED",
    reportType: "ANOMALY",
    distributionId,
    rowCount: report.data.anomalies.length,
  });
  return res.status(200).json({ success: true, data: { report } });
});

export const getFundUtilizationReport = asyncHandler(async (req, res) => {
  assertFundReportAllowed(req.staffUser);
  const report = await generateFundUtilizationReport(req.validatedQuery, req.staffUser);
  await recordReportAction(req, {
    action: "SIMULATED_FUND_UTILIZATION_REPORT_GENERATED",
    reportType: "SIMULATED_FUND_UTILIZATION",
    rowCount: report.data.distributions.length,
  });
  return res.status(200).json({ success: true, data: { report } });
});

export const exportDistributionCsv = asyncHandler(async (req, res) => {
  assertDetailedReportAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const exported = await generateDistributionCsvExport(distributionId, req.staffUser);
  await recordReportAction(req, {
    action: "DISTRIBUTION_COMPLIANCE_CSV_EXPORTED",
    reportType: "DISTRIBUTION_COMPLIANCE",
    distributionId,
    format: "CSV",
    rowCount: exported.rowCount,
  });
  applyCsvDownloadHeaders(res, exported.filename);
  return res.status(200).send(exported.csv);
});
