import { Router } from "express";
import { z } from "zod";
import prisma from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { authenticateMobile } from "./mobileAccount.auth.js";
import { beneficiaryAccessScope, BENEFICIARY_CREATE_ROLES } from "./beneficiary.policy.js";
import { beneficiarySelect } from "./beneficiary.service.js";
import { createBeneficiarySchema } from "./beneficiary.schemas.js";

const requestSchema = createBeneficiarySchema.pick({ firstName: true, middleName: true, lastName: true, birthDate: true }).extend({
  barangayId: z.uuid(), revision: z.number().int().positive().optional(),
}).strict();
const listSchema = z.object({
  status: z.enum(["PENDING", "LINKED", "REJECTED"]).default("PENDING"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
const paramsSchema = z.object({ accountId: z.uuid() });
const decisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("LINK"), beneficiaryId: z.uuid(), confirmedIdentity: z.literal(true), revision: z.number().int().positive(), note: z.string().trim().min(5).max(2000) }).strict(),
  z.object({ decision: z.literal("REJECT"), revision: z.number().int().positive(), note: z.string().trim().min(5).max(2000) }).strict(),
]);
const accountSelect = {
  accountId: true, status: true, revision: true, firstName: true, middleName: true, lastName: true,
  birthDate: true, barangayId: true, beneficiaryId: true, reviewNote: true, reviewedAt: true, createdAt: true,
};
const conflict = () => new AppError(409, "MOBILE_LINK_CONFLICT", "This request or beneficiary link has changed. Refresh the requests before continuing.");

export const mobileAccountRoutes = Router();
mobileAccountRoutes.use(authenticateMobile);
mobileAccountRoutes.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

mobileAccountRoutes.get("/barangays", validateQuery(listSchema.pick({ page: true, pageSize: true })), asyncHandler(async (req, res) => {
  const { page, pageSize } = req.validatedQuery;
  const where = { isActive: true };
  const [barangays, total] = await Promise.all([
    prisma.barangay.findMany({ where, select: { barangayId: true, barangayName: true, city: true, province: true }, orderBy: [{ barangayName: "asc" }, { barangayId: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.barangay.count({ where }),
  ]);
  res.json({ success: true, data: { barangays, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } } });
}));

mobileAccountRoutes.get("/me", asyncHandler(async (req, res) => {
  const account = await prisma.mobileBeneficiaryAccount.findUnique({
    where: { issuer_subject: req.mobileIdentity }, select: accountSelect,
  });
  // Mobile callers never receive a directory of other beneficiaries or possible matches.
  const beneficiary = account?.status === "LINKED" ? await prisma.beneficiary.findFirst({
    where: { beneficiaryId: account.beneficiaryId, status: "ACTIVE" },
    select: { beneficiaryId: true, firstName: true, middleName: true, lastName: true, birthDate: true, barangayId: true, status: true },
  }) : null;
  res.json({ success: true, data: { account, beneficiary } });
}));

mobileAccountRoutes.post("/link-request", validateBody(requestSchema), asyncHandler(async (req, res) => {
  const { revision, ...submitted } = req.validatedBody;
  const profile = { ...submitted, middleName: submitted.middleName ?? null };
  const barangay = await prisma.barangay.findFirst({ where: { barangayId: profile.barangayId, isActive: true }, select: { barangayId: true } });
  if (!barangay) throw new AppError(400, "INVALID_BARANGAY", "Choose an active service barangay.");
  try {
    const account = await prisma.$transaction(async tx => {
      const existing = await tx.mobileBeneficiaryAccount.findUnique({ where: { issuer_subject: req.mobileIdentity }, select: accountSelect });
      if (existing?.status === "LINKED") throw new AppError(409, "MOBILE_ACCOUNT_ALREADY_LINKED", "Your account is already linked. Contact the barangay office to correct your record.");
      if (existing?.status === "PENDING") {
        const unchanged = Object.entries(profile).every(([key, value]) => key === "birthDate"
          ? existing.birthDate.getTime() === value.getTime() : (existing[key] ?? null) === (value ?? null));
        if (unchanged) return existing;
      }
      let saved;
      if (existing) {
        if (revision !== existing.revision) throw conflict();
        const updated = await tx.mobileBeneficiaryAccount.updateMany({
          where: { accountId: existing.accountId, revision, status: { not: "LINKED" } },
          data: { ...profile, middleName: profile.middleName ?? null, status: "PENDING", revision: { increment: 1 }, reviewNote: null, reviewedAt: null, reviewedById: null },
        });
        if (updated.count !== 1) throw conflict();
        saved = await tx.mobileBeneficiaryAccount.findUniqueOrThrow({ where: { accountId: existing.accountId }, select: accountSelect });
      } else {
        if (revision !== undefined) throw conflict();
        saved = await tx.mobileBeneficiaryAccount.create({ data: { ...req.mobileIdentity, ...profile }, select: accountSelect });
      }
      await tx.auditLog.create({ data: {
        actorType: "BENEFICIARY", action: "MOBILE_LINK_REQUESTED", entityAffected: "MOBILE_ACCOUNT", recordId: saved.accountId,
        ipAddress: clientIpAddress(req), details: { revision: saved.revision },
      } });
      return saved;
    });
    res.json({ success: true, data: { account } });
  } catch (error) { if (error.code === "P2002") throw conflict(); throw error; }
}));

export const staffMobileAccountRoutes = Router();
staffMobileAccountRoutes.use(authenticateStaff, authorizeRoles(...BENEFICIARY_CREATE_ROLES));
staffMobileAccountRoutes.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

staffMobileAccountRoutes.get("/", validateQuery(listSchema), asyncHandler(async (req, res) => {
  const { status, page, pageSize } = req.validatedQuery;
  const scope = beneficiaryAccessScope(req.staffUser);
  const where = { status, ...(status === "LINKED" ? { beneficiary: { is: scope } } : scope) };
  const [accounts, total] = await Promise.all([
    prisma.mobileBeneficiaryAccount.findMany({ where, select: { ...accountSelect, beneficiary: { select: beneficiarySelect } }, orderBy: [{ createdAt: "asc" }, { accountId: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.mobileBeneficiaryAccount.count({ where }),
  ]);
  res.json({ success: true, data: { accounts, mobileAuthenticationConfigured: Boolean(env.mobileAuthPublicKey), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } } });
}));

staffMobileAccountRoutes.post("/:accountId/decision", validateParams(paramsSchema), validateBody(decisionSchema), asyncHandler(async (req, res) => {
  const { accountId } = req.validatedParams;
  const { decision, revision, note, beneficiaryId } = req.validatedBody;
  const scope = beneficiaryAccessScope(req.staffUser);
  try {
    const account = await prisma.$transaction(async tx => {
      const existing = await tx.mobileBeneficiaryAccount.findFirst({ where: { accountId, ...scope }, select: accountSelect });
      if (!existing) throw new AppError(404, "MOBILE_REQUEST_NOT_FOUND", "Mobile account request was not found.");
      if (existing.status !== "PENDING" || existing.revision !== revision) throw conflict();
      if (decision === "LINK") {
        const beneficiary = await tx.beneficiary.findFirst({ where: { beneficiaryId, status: "ACTIVE", ...scope }, select: { beneficiaryId: true, barangayId: true } });
        if (!beneficiary) throw new AppError(404, "BENEFICIARY_NOT_FOUND", "An active beneficiary in your authorized area was not found.");
        if (beneficiary.barangayId !== existing.barangayId) throw new AppError(409, "MOBILE_BARANGAY_MISMATCH", "The requested barangay differs from the beneficiary record. Correct the request or verified record before linking.");
      }
      const updated = await tx.mobileBeneficiaryAccount.updateMany({
        where: { accountId, status: "PENDING", revision, ...scope },
        data: { status: decision === "LINK" ? "LINKED" : "REJECTED", beneficiaryId: beneficiaryId ?? null, revision: { increment: 1 }, reviewNote: note, reviewedAt: new Date(), reviewedById: req.auth.userId },
      });
      if (updated.count !== 1) throw conflict();
      await tx.auditLog.create({ data: {
        userId: req.auth.userId, action: decision === "LINK" ? "MOBILE_ACCOUNT_LINKED" : "MOBILE_LINK_REJECTED", entityAffected: "MOBILE_ACCOUNT", recordId: accountId,
        ipAddress: clientIpAddress(req), details: { beneficiaryId: beneficiaryId ?? null, revision: revision + 1, note },
      } });
      return tx.mobileBeneficiaryAccount.findUniqueOrThrow({ where: { accountId }, select: accountSelect });
    });
    res.json({ success: true, data: { account } });
  } catch (error) {
    if (error.code === "P2002") throw new AppError(409, "BENEFICIARY_ALREADY_LINKED", "This beneficiary already has a linked mobile account. Do not create another beneficiary; ask the administrator to review account ownership.");
    throw error;
  }
}));
