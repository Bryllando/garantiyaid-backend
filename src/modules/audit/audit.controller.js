import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { assertAuditLogReadAllowed } from "./audit.policy.js";
import {
  auditLogPublicSelect,
  buildAuditLogWhere,
  getAuditLogOrThrow,
  sanitizeAuditLog,
  getAuditExport,
  writeAuditLog,
} from "./audit.service.js";

export const listAuditLogs = asyncHandler(async (req, res) => {
  assertAuditLogReadAllowed(req.staffUser);
  const { page, pageSize, ...filters } = req.validatedQuery;
  const where = buildAuditLogWhere(filters);

  const [auditLogs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      select: auditLogPublicSelect,
      orderBy: [{ createdAt: "desc" }, { auditId: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      auditLogs: auditLogs.map((auditLog) => sanitizeAuditLog(auditLog)),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
  });
});

export const getAuditLog = asyncHandler(async (req, res) => {
  assertAuditLogReadAllowed(req.staffUser);
  const auditLog = await getAuditLogOrThrow(req.validatedParams.auditId);

  res.status(200).json({ success: true, data: { auditLog } });
});

export const exportAuditLogs = asyncHandler(async (req, res) => {
  assertAuditLogReadAllowed(req.staffUser);
  const { page, pageSize, ...filters } = req.validatedQuery;
  const exported = await getAuditExport(filters);
  await writeAuditLog({ userId: req.auth.userId, action: "AUDIT_LOG_PDF_DATA_EXPORTED", entityAffected: "REPORT", details: { format: "PDF", rowCount: exported.total, filters: { ...filters, dateFrom: filters.dateFrom?.toISOString() ?? null, dateTo: filters.dateTo?.toISOString() ?? null } } });
  res.status(200).json({ success: true, data: exported });
});
