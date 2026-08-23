import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  assertDashboardReadAllowed,
} from "./dashboard.policy.js";
import {
  getDashboardOverview,
  getDistributionAnomalies,
  getDistributionDashboardSummary,
} from "./dashboard.service.js";

export const getOverview = asyncHandler(async (req, res) => {
  assertDashboardReadAllowed(req.staffUser);
  const overview = await getDashboardOverview(req.validatedQuery, req.staffUser);
  return res.status(200).json({ success: true, data: { overview } });
});

export const getDistributionSummary = asyncHandler(async (req, res) => {
  assertDashboardReadAllowed(req.staffUser);
  const summary = await getDistributionDashboardSummary(
    req.validatedParams.distributionId,
    req.staffUser,
  );
  return res.status(200).json({ success: true, data: { summary } });
});

export const getDistributionAnomalyDashboard = asyncHandler(async (req, res) => {
  assertDashboardReadAllowed(req.staffUser);
  const anomalies = await getDistributionAnomalies(
    req.validatedParams.distributionId,
    req.staffUser,
    req.validatedQuery,
  );
  return res.status(200).json({ success: true, data: { anomalies } });
});
