import prisma from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { acquireBiometricEnrollmentLock, biometricProfileStatus, consentEffectiveStatus } from "../biometrics/biometric.service.js";
import { lockMobileSession } from "./mobile.service.js";

const CONSENT_VERSION = "v1.0";
const consentSelect = { consentId: true, consentVersion: true, consentGiven: true, consentedAt: true,
  revokedAt: true, retentionUntil: true, recordedByBeneficiaryId: true };
const consentWhere = beneficiaryId => ({ beneficiaryId });
const consentOrder = [{ createdAt: "desc" }, { consentId: "desc" }];
function policy(now = new Date()) {
  const until = new Date(now);
  until.setUTCFullYear(until.getUTCFullYear() + 1); // Match the staff consent form's one-year default.
  return { version: CONSENT_VERSION, retentionUntil: until.toISOString() };
}

async function readStatus(session, database) {
  const beneficiaryId = session.account.beneficiaryId;
  const [consent, profile] = await Promise.all([
    database.biometricConsent.findFirst({ where: consentWhere(beneficiaryId), select: consentSelect, orderBy: consentOrder }),
    database.biometricData.findFirst({ where: { beneficiaryId, consent: { beneficiaryId } }, select: {
      biometricId: true, consentId: true, dataStatus: true, insightfaceModel: true, createdAt: true, lastVerifiedAt: true,
      consent: { select: { consentGiven: true, revokedAt: true, retentionUntil: true } },
    } }),
  ]);
  const active = consent && consentEffectiveStatus(consent) === "ACTIVE";
  const profileStatus = biometricProfileStatus(profile);
  return { enrollmentMethod: "staff_assisted", processorMode: env.biometricProcessorMode.toLowerCase(), policy: policy(),
    consent: consent ? { id: consent.consentId, version: consent.consentVersion,
      status: consentEffectiveStatus(consent).toLowerCase(), consentedAt: consent.consentedAt.toISOString(),
      revokedAt: consent.revokedAt?.toISOString() ?? null, retentionUntil: consent.retentionUntil.toISOString() } : null,
    profile: profile ? { id: profile.biometricId, consentId: profile.consentId,
      status: (profileStatus === "ENROLLED" && (!active || profile.consentId !== consent.consentId)
        ? "CONSENT_REQUIRED" : profileStatus).toLowerCase(),
      simulated: profile.insightfaceModel === "gya-simulated-v1",
      processorCompatible: profile.insightfaceModel === (env.biometricProcessorMode === "REMOTE" ? "ArcFace" : "gya-simulated-v1"),
      enrolledAt: profile.createdAt.toISOString(), lastVerifiedAt: profile.lastVerifiedAt?.toISOString() ?? null } : null,
  };
}

export function getMobileBiometrics(session) {
  return prisma.$transaction(tx => readStatus(session, tx), { isolationLevel: "RepeatableRead" });
}

async function audit(database, session, consentId, action) {
  await database.auditLog.create({ data: { actorType: "BENEFICIARY", action,
    entityAffected: "BIOMETRIC_CONSENT", recordId: consentId,
    details: { source: "MOBILE_APP", beneficiaryId: session.account.beneficiaryId, rawCaptureStored: false } } });
}

async function changeConsent(session, change) {
  try {
    await prisma.$transaction(async tx => {
      await lockMobileSession(tx, session);
      await acquireBiometricEnrollmentLock(tx);
      await change(tx);
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (["P2034", "P2002"].includes(error.code)) throw new AppError(409, "BIOMETRIC_CONSENT_CHANGED", "The consent record changed. Refresh it and try again.");
    throw error;
  }
  return getMobileBiometrics(session);
}

export function giveMobileBiometricConsent(session, input) {
  const beneficiaryId = session.account.beneficiaryId;
  const until = new Date(input.retentionUntil);
  if (input.consentVersion !== CONSENT_VERSION || until <= new Date() || until > new Date(policy().retentionUntil)) {
    throw new AppError(409, "BIOMETRIC_POLICY_CHANGED", "Review the current consent notice and retention date before continuing.");
  }
  return changeConsent(session, async tx => {
    const latest = await tx.biometricConsent.findFirst({ where: consentWhere(beneficiaryId), select: consentSelect, orderBy: consentOrder });
    if (latest && consentEffectiveStatus(latest) === "ACTIVE" && latest.recordedByBeneficiaryId === beneficiaryId
      && latest.consentVersion === input.consentVersion && latest.retentionUntil.getTime() === until.getTime()) return;
    if ((latest?.consentId ?? null) !== input.expectedConsentId) throw new AppError(409, "BIOMETRIC_CONSENT_CHANGED", "The consent record changed. Refresh it and try again.");
    const now = new Date();
    await tx.biometricConsent.updateMany({ where: { beneficiaryId, consentGiven: true, revokedAt: null }, data: { revokedAt: now } });
    await tx.biometricData.updateMany({ where: { beneficiaryId, dataStatus: { in: ["ACTIVE", "PENDING_DUPLICATE_REVIEW", "DUPLICATE_BLOCKED"] } }, data: { dataStatus: "REVOKED" } });
    const consent = await tx.biometricConsent.create({ data: { beneficiaryId, recordedByBeneficiaryId: beneficiaryId,
      consentGiven: true, consentVersion: CONSENT_VERSION, consentedAt: now, retentionUntil: until } });
    await audit(tx, session, consent.consentId, "MOBILE_BIOMETRIC_CONSENT_GIVEN");
  });
}

export function revokeMobileBiometricConsent(session, consentId) {
  const beneficiaryId = session.account.beneficiaryId;
  return changeConsent(session, async tx => {
    const consent = await tx.biometricConsent.findFirst({ where: { consentId, beneficiaryId }, select: consentSelect });
    if (!consent) throw new AppError(404, "BIOMETRIC_CONSENT_NOT_FOUND", "Consent record not found.");
    if (!consent.consentGiven || consent.revokedAt) return;
    const revokedAt = new Date();
    await tx.biometricConsent.update({ where: { consentId }, data: { revokedAt } });
    await tx.biometricData.updateMany({ where: { beneficiaryId, consentId, dataStatus: { in: ["ACTIVE", "PENDING_DUPLICATE_REVIEW", "DUPLICATE_BLOCKED"] } }, data: { dataStatus: "REVOKED" } });
    await audit(tx, session, consentId, "MOBILE_BIOMETRIC_CONSENT_REVOKED");
  });
}
