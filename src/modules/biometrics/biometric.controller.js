import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { getBeneficiaryOrThrow } from "../beneficiaries/beneficiary.service.js";
import {
  assertBiometricConsentManageAllowed,
  assertBiometricDeleteAllowed,
  assertBiometricEnrollAllowed,
  assertBiometricReadAllowed,
} from "./biometric.policy.js";
import {
  biometricProcessingDisclosure,
  biometricProfileInternalSelect,
  biometricProfileToResponse,
  consentEffectiveStatus,
  consentToResponse,
  encryptBiometricTemplate,
  processBiometricEnrollment,
} from "./biometric.service.js";

const consentSelect = {
  consentId: true,
  beneficiaryId: true,
  consentVersion: true,
  consentGiven: true,
  consentedAt: true,
  revokedAt: true,
  retentionUntil: true,
  recordedById: true,
  createdAt: true,
  updatedAt: true,
  biometricData: {
    select: { biometricId: true, dataStatus: true },
  },
};

async function activeConsentOrThrow(beneficiaryId, consentId, database = prisma) {
  const consent = await database.biometricConsent.findFirst({
    where: {
      beneficiaryId,
      ...(consentId ? { consentId } : {}),
      consentGiven: true,
      revokedAt: null,
      retentionUntil: { gt: new Date() },
    },
    select: consentSelect,
    orderBy: { consentedAt: "desc" },
  });
  if (!consent) {
    throw new AppError(
      409,
      "ACTIVE_BIOMETRIC_CONSENT_REQUIRED",
      "A current, unrevoked biometric consent is required before enrollment.",
    );
  }
  return consent;
}

export const listBiometricConsents = asyncHandler(async (req, res) => {
  assertBiometricReadAllowed(req.staffUser);
  const beneficiary = await getBeneficiaryOrThrow(req.validatedParams.beneficiaryId, req.staffUser);
  const { page, pageSize } = req.validatedQuery;
  const where = { beneficiaryId: beneficiary.beneficiaryId };
  const [consents, total] = await Promise.all([
    prisma.biometricConsent.findMany({
      where,
      select: consentSelect,
      orderBy: [{ consentedAt: "desc" }, { consentId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.biometricConsent.count({ where }),
  ]);
  return res.status(200).json({
    success: true,
    data: {
      consents: consents.map((consent) => consentToResponse(consent)),
      summary: {
        matchingConsentCount: total,
        activeConsentCount: consents.filter((consent) => consentEffectiveStatus(consent) === "ACTIVE").length,
      },
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
  });
});

export const revokeBiometricConsent = asyncHandler(async (req, res) => {
  assertBiometricConsentManageAllowed(req.staffUser);
  const beneficiary = await getBeneficiaryOrThrow(req.validatedParams.beneficiaryId, req.staffUser);
  const result = await prisma.$transaction(async (tx) => {
    const consent = await tx.biometricConsent.findFirst({
      where: {
        consentId: req.validatedParams.consentId,
        beneficiaryId: beneficiary.beneficiaryId,
      },
      select: consentSelect,
    });
    if (!consent) {
      throw new AppError(404, "BIOMETRIC_CONSENT_NOT_FOUND", "Biometric consent record was not found.");
    }
    if (consent.revokedAt || !consent.consentGiven) {
      throw new AppError(409, "BIOMETRIC_CONSENT_NOT_REVOCABLE", "This biometric consent is not active.");
    }
    const revokedAt = new Date();
    await tx.biometricConsent.update({ where: { consentId: consent.consentId }, data: { revokedAt } });
    const profileUpdate = await tx.biometricData.updateMany({
      where: { consentId: consent.consentId, dataStatus: "ACTIVE" },
      data: { dataStatus: "REVOKED" },
    });
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "BIOMETRIC_CONSENT_REVOKED",
        entityAffected: "BIOMETRIC_CONSENT",
        recordId: consent.consentId,
        ipAddress: clientIpAddress(req),
        details: {
          beneficiaryId: beneficiary.beneficiaryId,
          biometricProfileRevoked: profileUpdate.count === 1,
          rawCaptureStored: false,
        },
      },
    });
    return { ...consent, revokedAt };
  });
  return res.status(200).json({
    success: true,
    data: { consent: consentToResponse(result), biometricVerificationBlocked: true },
  });
});

async function saveEnrollment(req, res, requireExistingProfile) {
  assertBiometricEnrollAllowed(req.staffUser);
  const beneficiary = await getBeneficiaryOrThrow(req.validatedParams.beneficiaryId, req.staffUser);
  if (beneficiary.status !== "ACTIVE") {
    throw new AppError(409, "BENEFICIARY_NOT_ACTIVE", "Only an active beneficiary can enroll biometrics.");
  }
  const consent = await activeConsentOrThrow(beneficiary.beneficiaryId, req.validatedBody.consentId);
  let processing;
  try {
    processing = await processBiometricEnrollment(req.file);
  } finally {
    req.file?.buffer?.fill(0);
  }
  if (!processing.livenessPassed) {
    await prisma.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "BIOMETRIC_ENROLLMENT_REJECTED",
        entityAffected: "BENEFICIARY",
        recordId: beneficiary.beneficiaryId,
        ipAddress: clientIpAddress(req),
        details: {
          reason: "LIVENESS_FAILED",
          livenessScore: processing.livenessScore.toFixed(4),
          processor: processing.processor,
          rawCaptureStored: false,
        },
      },
    });
    throw new AppError(422, "BIOMETRIC_LIVENESS_FAILED", "Biometric enrollment failed liveness verification.");
  }

  const encryptedTemplate = encryptBiometricTemplate(
    processing.embedding,
    beneficiary.beneficiaryId,
    consent.consentId,
  );
  const biometricId = await prisma.$transaction(async (tx) => {
    const currentConsent = await activeConsentOrThrow(beneficiary.beneficiaryId, consent.consentId, tx);
    const existing = await tx.biometricData.findUnique({
      where: { beneficiaryId: beneficiary.beneficiaryId },
      select: { biometricId: true },
    });
    if (requireExistingProfile && !existing) {
      throw new AppError(404, "BIOMETRIC_PROFILE_NOT_FOUND", "No biometric profile exists to re-enroll.");
    }
    if (!requireExistingProfile && existing) {
      throw new AppError(409, "BIOMETRIC_PROFILE_ALREADY_EXISTS", "Use the re-enrollment endpoint to replace an existing profile.");
    }
    const profile = existing
      ? await tx.biometricData.update({
          where: { biometricId: existing.biometricId },
          data: {
            enrolledById: req.auth.userId,
            consentId: currentConsent.consentId,
            faceEmbedding: encryptedTemplate,
            insightfaceModel: processing.model,
            dataStatus: "ACTIVE",
            livenessScore: processing.livenessScore,
            livenessPassed: true,
            verificationCount: 0,
            lastVerifiedAt: null,
          },
          select: { biometricId: true },
        })
      : await tx.biometricData.create({
          data: {
            beneficiaryId: beneficiary.beneficiaryId,
            enrolledById: req.auth.userId,
            consentId: currentConsent.consentId,
            faceEmbedding: encryptedTemplate,
            insightfaceModel: processing.model,
            dataStatus: "ACTIVE",
            livenessScore: processing.livenessScore,
            livenessPassed: true,
          },
          select: { biometricId: true },
        });
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: existing ? "BIOMETRIC_PROFILE_REENROLLED" : "BIOMETRIC_PROFILE_ENROLLED",
        entityAffected: "BIOMETRIC_DATA",
        recordId: profile.biometricId,
        ipAddress: clientIpAddress(req),
        details: {
          beneficiaryId: beneficiary.beneficiaryId,
          consentId: currentConsent.consentId,
          model: processing.model,
          processor: processing.processor,
          livenessPassed: true,
          rawCaptureStored: false,
          templateEncrypted: true,
        },
      },
    });
    return profile.biometricId;
  });
  const profile = await prisma.biometricData.findUniqueOrThrow({
    where: { biometricId },
    select: biometricProfileInternalSelect,
  });
  return res.status(requireExistingProfile ? 200 : 201).json({
    success: true,
    data: {
      biometricProfile: biometricProfileToResponse(profile),
      processing: {
        ...biometricProcessingDisclosure,
        livenessPassed: true,
      },
    },
  });
}

export const enrollBiometricProfile = asyncHandler((req, res) => saveEnrollment(req, res, false));
export const reenrollBiometricProfile = asyncHandler((req, res) => saveEnrollment(req, res, true));

export const getBiometricStatus = asyncHandler(async (req, res) => {
  assertBiometricReadAllowed(req.staffUser);
  const beneficiary = await getBeneficiaryOrThrow(req.validatedParams.beneficiaryId, req.staffUser);
  const profile = await prisma.biometricData.findUnique({
    where: { beneficiaryId: beneficiary.beneficiaryId },
    select: biometricProfileInternalSelect,
  });
  if (profile?.dataStatus === "ACTIVE" && profile.consent.retentionUntil <= new Date()) {
    await prisma.biometricData.update({
      where: { biometricId: profile.biometricId },
      data: { dataStatus: "EXPIRED" },
    });
    profile.dataStatus = "EXPIRED";
  }
  return res.status(200).json({
    success: true,
    data: {
      beneficiaryId: beneficiary.beneficiaryId,
      biometricProfile: biometricProfileToResponse(profile),
      processing: biometricProcessingDisclosure,
    },
  });
});

export const deleteBiometricProfile = asyncHandler(async (req, res) => {
  assertBiometricDeleteAllowed(req.staffUser);
  const beneficiary = await getBeneficiaryOrThrow(req.validatedParams.beneficiaryId, req.staffUser);
  const result = await prisma.$transaction(async (tx) => {
    const profile = await tx.biometricData.findUnique({
      where: { beneficiaryId: beneficiary.beneficiaryId },
      select: { biometricId: true, consentId: true, dataStatus: true },
    });
    if (!profile) {
      throw new AppError(404, "BIOMETRIC_PROFILE_NOT_FOUND", "Biometric profile was not found.");
    }
    await tx.biometricData.delete({ where: { biometricId: profile.biometricId } });
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "BIOMETRIC_DATA_DELETED",
        entityAffected: "BIOMETRIC_DATA",
        recordId: profile.biometricId,
        ipAddress: clientIpAddress(req),
        details: {
          beneficiaryId: beneficiary.beneficiaryId,
          consentId: profile.consentId,
          priorStatus: profile.dataStatus,
          rawCaptureStored: false,
          templatePermanentlyDeleted: true,
        },
      },
    });
    return profile;
  });
  return res.status(200).json({
    success: true,
    data: {
      beneficiaryId: beneficiary.beneficiaryId,
      biometricId: result.biometricId,
      deleted: true,
      biometricStatus: "NOT_ENROLLED",
    },
  });
});
