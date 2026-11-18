import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
import { reportSnapshotQuerySchema } from "./report.schemas.js";
import { reportRateLimiter } from "../../middleware/rateLimit.js";
import {
  DETAILED_REPORT_ROLES,
  DISTRIBUTION_SUMMARY_REPORT_ROLES,
  FUND_REPORT_ROLES,
} from "../dashboard/dashboard.policy.js";
import {
  anomalyQuerySchema,
  claimReportQuerySchema,
  dashboardDistributionParamsSchema,
  fundUtilizationQuerySchema,
  scheduleReportQuerySchema,
} from "../dashboard/dashboard.schemas.js";
import {
  exportDistributionCsv,
  getAnomalyReport,
  getClaimStatusReport,
  getDistributionSummaryReport,
  getFundUtilizationReport,
  getQueueScheduleReport,
  getReportSnapshot,
  explainReportSnapshot,
} from "./report.controller.js";

const reportRoutes = Router();

reportRoutes.use(authenticateStaff, reportRateLimiter);
reportRoutes.get("/snapshot", authorizeRoles(...DETAILED_REPORT_ROLES), validateQuery(reportSnapshotQuerySchema), getReportSnapshot);
reportRoutes.post("/explain", authorizeRoles(...DETAILED_REPORT_ROLES), validateBody(reportSnapshotQuerySchema), explainReportSnapshot);
reportRoutes.get(
  "/distributions/:distributionId/summary",
  authorizeRoles(...DISTRIBUTION_SUMMARY_REPORT_ROLES),
  validateParams(dashboardDistributionParamsSchema),
  getDistributionSummaryReport,
);
reportRoutes.get(
  "/distributions/:distributionId/claims",
  authorizeRoles(...DETAILED_REPORT_ROLES),
  validateParams(dashboardDistributionParamsSchema),
  validateQuery(claimReportQuerySchema),
  getClaimStatusReport,
);
reportRoutes.get(
  "/distributions/:distributionId/schedules",
  authorizeRoles(...DETAILED_REPORT_ROLES),
  validateParams(dashboardDistributionParamsSchema),
  validateQuery(scheduleReportQuerySchema),
  getQueueScheduleReport,
);
reportRoutes.get(
  "/distributions/:distributionId/anomalies",
  authorizeRoles(...DETAILED_REPORT_ROLES),
  validateParams(dashboardDistributionParamsSchema),
  validateQuery(anomalyQuerySchema),
  getAnomalyReport,
);
reportRoutes.get(
  "/distributions/:distributionId/export.csv",
  authorizeRoles(...DETAILED_REPORT_ROLES),
  validateParams(dashboardDistributionParamsSchema),
  exportDistributionCsv,
);
reportRoutes.get(
  "/fund-utilization",
  authorizeRoles(...FUND_REPORT_ROLES),
  validateQuery(fundUtilizationQuerySchema),
  getFundUtilizationReport,
);

export default reportRoutes;
