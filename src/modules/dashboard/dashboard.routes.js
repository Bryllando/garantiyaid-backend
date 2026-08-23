import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { validateParams, validateQuery } from "../../middleware/validate.js";
import {
  getDistributionAnomalyDashboard,
  getDistributionSummary,
  getOverview,
} from "./dashboard.controller.js";
import { DASHBOARD_READ_ROLES } from "./dashboard.policy.js";
import {
  anomalyQuerySchema,
  dashboardDistributionParamsSchema,
  dashboardOverviewQuerySchema,
} from "./dashboard.schemas.js";

const dashboardRoutes = Router();

dashboardRoutes.use(authenticateStaff, authorizeRoles(...DASHBOARD_READ_ROLES));
dashboardRoutes.get(
  "/overview",
  validateQuery(dashboardOverviewQuerySchema),
  getOverview,
);
dashboardRoutes.get(
  "/distributions/:distributionId/anomalies",
  validateParams(dashboardDistributionParamsSchema),
  validateQuery(anomalyQuerySchema),
  getDistributionAnomalyDashboard,
);
dashboardRoutes.get(
  "/distributions/:distributionId",
  validateParams(dashboardDistributionParamsSchema),
  getDistributionSummary,
);

export default dashboardRoutes;
