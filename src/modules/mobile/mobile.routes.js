import { Router } from "express";
import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
import { chatbotRateLimiter } from "../../middleware/rateLimit.js";
import { createMobileSupportRequest, getMobileSupportRequest, listMobileSupportRequests, replyMobileSupportRequest } from "./mobileSupport.service.js";
import { mobileSupportCreateSchema, mobileSupportReplySchema, mobileSupportParamsSchema, mobileSupportListSchema } from "./mobile.schemas.js";
import { uploadBeneficiaryDocument } from "../documents/beneficiaryDocument.upload.js";
import { beneficiaryDocumentParamsSchema } from "../documents/beneficiaryDocument.schemas.js";
import { downloadMobileDocument, listMobileDocuments, listMobileDocumentRequirements, uploadMobileDocument } from "./mobileDocuments.controller.js";
import { mobileDocumentRequirementQuerySchema } from "./mobile.schemas.js";
import { getMobileOverview } from "./mobileOverview.service.js";
import { issueMobileClaimPass } from "./mobileClaimPass.service.js";
import { getMobileWallet } from "./mobileWallet.service.js";
import { getMobileBiometrics, giveMobileBiometricConsent, revokeMobileBiometricConsent } from "./mobileBiometrics.service.js";
import { mobileBiometricConsentSchema, mobileBiometricConsentParamsSchema } from "./mobile.schemas.js";
import { getMobileNotifications, readMobileNotification } from "./mobileNotifications.service.js";
import { mobileNotificationParamsSchema } from "./mobile.schemas.js";
import { mobileAuthenticationRateLimiter } from "../../middleware/rateLimit.js";
import { mobileOtpRequestSchema, mobileOtpVerificationSchema, mobileProfileSchema, mobileRegistrationSchema } from "./mobile.schemas.js";
import { authenticateMobile, logoutMobile, mobileProfile, registerMobile, requestMobileOtp, updateMobileProfile, verifyMobileOtp } from "./mobile.service.js";

import { z } from "zod";
import { biometricRateLimiter } from "../../middleware/rateLimit.js";
import { uploadBiometricCapture } from "../biometrics/biometric.upload.js";
import { submitIdentity } from "./mobileIdentity.service.js";

const mobileRoutes = Router();
mobileRoutes.use((_req,res,next) => { res.set("Cache-Control","private, no-store"); next(); });

mobileRoutes.get("/auth/barangays", asyncHandler(async (_req, res) => {
  const barangays = await prisma.barangay.findMany({
    where: { isActive: true }, orderBy: [{ city: "asc" }, { barangayName: "asc" }],
    select: { barangayId: true, barangayCode: true, barangayName: true, city: true, province: true },
  });
  res.json({ success: true, data: barangays.map(({ barangayId, ...area }) => ({ id: barangayId, ...area })) });
}));

mobileRoutes.post("/auth/register", mobileAuthenticationRateLimiter, validateBody(mobileRegistrationSchema), asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await registerMobile(req.validatedBody) });
}));
mobileRoutes.post("/auth/otp/request", mobileAuthenticationRateLimiter, validateBody(mobileOtpRequestSchema), asyncHandler(async (req, res) => {
  res.status(202).json({ success: true, data: await requestMobileOtp(req.validatedBody) });
}));
mobileRoutes.post("/auth/otp/verify", mobileAuthenticationRateLimiter, validateBody(mobileOtpVerificationSchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await verifyMobileOtp(req.validatedBody) });
}));

mobileRoutes.use(["/beneficiaries/me", "/auth/logout"], asyncHandler(async (req, _res, next) => {
  req.mobileSession = await authenticateMobile(req.get("authorization"));
  next();
}));
mobileRoutes.get("/beneficiaries/me", (req, res) => {
  res.json({ success: true, data: mobileProfile(req.mobileSession.account) });
});
mobileRoutes.use("/beneficiaries/me", (req, res, next) => {
  if (req.method === "PATCH" && req.path === "/") return next();
  if (!req.mobileSession.account.beneficiaryId) return res.status(409).json({ success: false, error: { code: "LINK_REQUIRED", message: "Your barangay must link your account to its beneficiary record first." } });
  next();
});
mobileRoutes.post("/beneficiaries/me/identity", biometricRateLimiter, uploadBiometricCapture,
  validateBody(z.object({ documentId: z.uuid(), consentId: z.uuid(), consentVersion: z.literal("id-selfie-v1") }).strict()), asyncHandler(async (req, res) => {
    res.json({ success: true, data: await submitIdentity(req.mobileSession, req.validatedBody, req.file) });
  }));
mobileRoutes.get("/beneficiaries/me/overview", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store").json({ success: true, data: await getMobileOverview(req.mobileSession) });
}));
mobileRoutes.get("/beneficiaries/me/wallet", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store").json({ success: true, data: await getMobileWallet(req.mobileSession) });
}));
mobileRoutes.get("/beneficiaries/me/support", validateQuery(mobileSupportListSchema), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store").json({ success: true, data: await listMobileSupportRequests(req.mobileSession, req.validatedQuery) });
}));
mobileRoutes.post("/beneficiaries/me/support", chatbotRateLimiter, validateBody(mobileSupportCreateSchema), asyncHandler(async (req, res) => {
  res.status(201).set("Cache-Control", "private, no-store").json({ success: true, data: await createMobileSupportRequest(req.mobileSession, req.validatedBody) });
}));
mobileRoutes.get("/beneficiaries/me/support/:requestId", validateParams(mobileSupportParamsSchema), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store").json({ success: true, data: await getMobileSupportRequest(req.mobileSession, req.validatedParams.requestId) });
}));
mobileRoutes.post("/beneficiaries/me/support/:requestId/messages", chatbotRateLimiter, validateParams(mobileSupportParamsSchema), validateBody(mobileSupportReplySchema), asyncHandler(async (req, res) => {
  res.status(201).set("Cache-Control", "private, no-store").json({ success: true, data: await replyMobileSupportRequest(req.mobileSession, req.validatedParams.requestId, req.validatedBody) });
}));
mobileRoutes.get("/beneficiaries/me/biometrics", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store").json({ success: true, data: await getMobileBiometrics(req.mobileSession) });
}));
mobileRoutes.post("/beneficiaries/me/biometric-consents", validateBody(mobileBiometricConsentSchema), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store").json({ success: true, data: await giveMobileBiometricConsent(req.mobileSession, req.validatedBody) });
}));
mobileRoutes.post("/beneficiaries/me/biometric-consents/:consentId/revoke", validateParams(mobileBiometricConsentParamsSchema), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store").json({ success: true, data: await revokeMobileBiometricConsent(req.mobileSession, req.validatedParams.consentId) });
}));
mobileRoutes.get("/beneficiaries/me/notifications", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store").json({ success: true, data: await getMobileNotifications(req.mobileSession) });
}));
mobileRoutes.patch("/beneficiaries/me/notifications/:notificationId/read", validateParams(mobileNotificationParamsSchema), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store").json({ success: true, data: await readMobileNotification(req.mobileSession, req.validatedParams.notificationId) });
}));
mobileRoutes.post("/beneficiaries/me/claim-pass", mobileAuthenticationRateLimiter, asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store").json({ success: true, data: await issueMobileClaimPass(req.mobileSession) });
}));
mobileRoutes.get("/beneficiaries/me/documents", listMobileDocuments);
mobileRoutes.get("/beneficiaries/me/document-requirements", validateQuery(mobileDocumentRequirementQuerySchema), listMobileDocumentRequirements);
mobileRoutes.post("/beneficiaries/me/documents", uploadBeneficiaryDocument, uploadMobileDocument);
mobileRoutes.post("/beneficiaries/me/documents/:documentId/replacement", validateParams(beneficiaryDocumentParamsSchema.pick({ documentId: true })), uploadBeneficiaryDocument, uploadMobileDocument);
mobileRoutes.get("/beneficiaries/me/documents/:documentId/content", validateParams(beneficiaryDocumentParamsSchema.pick({ documentId: true })), downloadMobileDocument);
mobileRoutes.patch("/beneficiaries/me", validateBody(mobileProfileSchema), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await updateMobileProfile(req.mobileSession, req.validatedBody) });
}));
mobileRoutes.post("/auth/logout", asyncHandler(async (req, res) => {
  await logoutMobile(req.mobileSession);
  res.sendStatus(204);
}));

// Keep authenticated mobile requests within their own session protocol.
mobileRoutes.use("/beneficiaries/me", (_req, res) => res.status(404).json({
  success: false, error: { code: "NOT_FOUND", message: "This mobile feature is unavailable." },
}));

export default mobileRoutes;
