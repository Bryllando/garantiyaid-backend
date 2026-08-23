import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { validateParams, validateQuery } from "../../middleware/validate.js";
import { getAuditLog, listAuditLogs } from "./audit.controller.js";
import { AUDIT_LOG_READ_ROLES } from "./audit.policy.js";
import { auditLogIdSchema, auditLogListQuerySchema } from "./audit.schemas.js";

const auditLogRoutes = Router();

auditLogRoutes.use(authenticateStaff, authorizeRoles(...AUDIT_LOG_READ_ROLES));
auditLogRoutes.get("/", validateQuery(auditLogListQuerySchema), listAuditLogs);
auditLogRoutes.get("/:auditId", validateParams(auditLogIdSchema), getAuditLog);

export default auditLogRoutes;
