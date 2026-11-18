import { z } from "zod";
import { anomalyQuerySchema, claimReportQuerySchema, emptyReportQuerySchema, fundUtilizationQuerySchema, scheduleReportQuerySchema } from "../dashboard/dashboard.schemas.js";

const schemas = { SUMMARY: emptyReportQuerySchema, CLAIMS: claimReportQuerySchema, SCHEDULES: scheduleReportQuerySchema, ANOMALIES: anomalyQuerySchema, FUNDS: fundUtilizationQuerySchema };

export const reportSnapshotQuerySchema = z.object({
  type: z.enum(["SUMMARY", "CLAIMS", "SCHEDULES", "ANOMALIES", "FUNDS"]),
  distributionId: z.uuid().optional(),
  status: z.string().trim().toUpperCase().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
}).strict().transform((scope, context) => {
  if (scope.type !== "FUNDS" && !scope.distributionId) {
    context.addIssue({ code: "custom", path: ["distributionId"], message: "Select a distribution event." });
    return z.NEVER;
  }
  const { type, distributionId, ...filters } = scope;
  const parsed = schemas[type].safeParse(type === "FUNDS" ? { ...filters, distributionId } : filters);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) context.addIssue(issue);
    return z.NEVER;
  }
  return { scope, filters: parsed.data };
});
