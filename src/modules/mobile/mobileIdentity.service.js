import { readFile } from "node:fs/promises";
import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { matchIdentityPortrait } from "../biometrics/biometric.service.js";
import { resolveBeneficiaryDocumentPath } from "../documents/beneficiaryDocument.service.js";
import { lockMobileSession } from "./mobile.service.js";

const activeConsent = (beneficiaryId, consentId) => ({
  beneficiaryId, consentId, recordedByBeneficiaryId: beneficiaryId, consentGiven: true, revokedAt: null,
  retentionUntil: { gt: new Date() },
});
const portraitWhere = (beneficiaryId, documentId) => ({
  beneficiaryId, documentId, documentType: { in: ["VALID_ID","PWD_ID","SENIOR_CITIZEN_ID"] },
  reviewStatus: { in: ["SUBMITTED","ACCEPTED"] },
});
const conflict = () => new AppError(409, "IDENTITY_REVIEW_CHANGED", "The identity or evidence changed. Refresh before continuing.");

export async function submitIdentity(session, { documentId, consentId }, selfie) {
  const { beneficiaryId, link } = session.account;
  if (!selfie) throw new AppError(400, "SELFIE_REQUIRED", "Take a live selfie.");
  if (link.identityStatus === "APPROVED") throw conflict();
  const evidence = portraitWhere(beneficiaryId, documentId);
  const [document, consent] = await Promise.all([
    prisma.beneficiaryDocument.findFirst({ where: evidence, select: { filePath: true, mimeType: true } }),
    prisma.biometricConsent.findFirst({ where: activeConsent(beneficiaryId, consentId), select: { consentId: true } }),
  ]);
  if (!consent) throw new AppError(409,"CONSENT_REQUIRED","Review and give consent before taking a selfie.");
  if (!document) throw new AppError(422,"ID_REQUIRED","Choose your current photo ID.");
  let matched = false;
  let note = "The selfie did not match a live face and the ID portrait. Retake the selfie or contact staff.";
  let bytes;
  try {
    if (!["image/jpeg","image/png"].includes(document.mimeType)) throw new AppError(422,"ID_IMAGE_REQUIRED","Upload the portrait side of your ID as a JPEG or PNG.");
    bytes = await readFile(resolveBeneficiaryDocumentPath(document.filePath));
    matched = await matchIdentityPortrait({ buffer: bytes }, selfie);
  } catch (error) {
    if (error.code === "ENOENT") note = "The uploaded photo ID is unavailable. Contact staff.";
    else if (error instanceof AppError) note = error.statusCode >= 500
      ? "The face service is unavailable. Try again later or contact staff." : error.message;
    else throw error;
  } finally { bytes?.fill(0); }
  const identityStatus = matched ? "MATCHED" : "CORRECTION";
  await prisma.$transaction(async tx => {
    await lockMobileSession(tx, session);
    if (!await tx.biometricConsent.findFirst({ where: activeConsent(beneficiaryId, consentId) })
      || !await tx.beneficiaryDocument.findFirst({ where: evidence })) throw conflict();
    const saved = await tx.mobileBeneficiaryAccount.updateMany({
      where: { accountId: link.accountId, beneficiaryId, status: "LINKED", revision: link.revision, identityStatus: { not: "APPROVED" } },
      data: { identityStatus, identityDocumentId: documentId, identityConsentId: consentId, identityNote: matched ? null : note, revision: { increment: 1 } },
    });
    if (saved.count !== 1) throw conflict();
    await tx.auditLog.create({ data: { actorType: "BENEFICIARY", action: "MOBILE_IDENTITY_COMPARED", entityAffected: "MOBILE_ACCOUNT",
      recordId: link.accountId, details: { beneficiaryId, identityStatus, documentId, consentId, consentVersion: "id-selfie-v1" } } });
  }, { isolationLevel: "Serializable" });
  return { identityStatus, identityNote: matched ? null : note };
}

export async function decideIdentity(accountId, userId, { decision, revision, note }) {
  return prisma.$transaction(async tx => {
    const link = await tx.mobileBeneficiaryAccount.findUnique({ where: { accountId } });
    if (!link || link.status !== "LINKED" || link.revision !== revision || link.identityStatus !== "MATCHED") throw conflict();
    const { beneficiaryId, identityDocumentId, identityConsentId } = link;
    if (decision === "APPROVE") {
      const accepted = await tx.beneficiaryDocument.findFirst({ where: { ...portraitWhere(beneficiaryId, identityDocumentId), reviewStatus: "ACCEPTED" } });
      if (!accepted) throw new AppError(409,"ID_REVIEW_REQUIRED","Review and accept the matching photo ID in the beneficiary record first.");
      if (!await tx.biometricConsent.findFirst({ where: activeConsent(beneficiaryId, identityConsentId) })) throw conflict();
      if (!await tx.beneficiary.findFirst({ where: { beneficiaryId, status: "ACTIVE" } })) throw conflict();
    }
    const identityStatus = decision === "APPROVE" ? "APPROVED" : "CORRECTION";
    const changed = await tx.mobileBeneficiaryAccount.updateMany({ where: { accountId, revision, identityStatus: "MATCHED" },
      data: { identityStatus, identityNote: note, revision: { increment: 1 } } });
    if (changed.count !== 1) throw conflict();
    await tx.auditLog.create({ data: { userId, action: "MOBILE_IDENTITY_REVIEWED", entityAffected: "MOBILE_ACCOUNT", recordId: accountId,
      details: { beneficiaryId, decision, note, documentId: identityDocumentId, consentId: identityConsentId, revision } } });
    return { identityStatus };
  }, { isolationLevel: "Serializable" });
}
