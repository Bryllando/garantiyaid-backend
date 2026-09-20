import prisma from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { getBeneficiaryOrThrow } from "../beneficiaries/beneficiary.service.js";
import {
  assertBiometricConsentManageAllowed,
  assertBiometricDeleteAllowed,
  assertBiometricDuplicateReviewAllowed,
  assertBiometricEnrollAllowed,
  assertIndependentBiometricDuplicateReviewer,
  assertBiometricReadAllowed,
} from "./biometric.policy.js";
import {
  acquireBiometricEnrollmentLock,
  biometricDuplicateCasePublicSelect,
  biometricDuplicateCaseToResponse,
  biometricProcessingDisclosure,
  biometricProfileInternalSelect,
  biometricProfileToResponse,
  consentEffectiveStatus,
  consentToResponse,
  duplicateScanWhere,
  encryptBiometricTemplate,
  findBiometricDuplicateMatch,
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
      where: {
        consentId: consent.consentId,
        dataStatus: { in: ["ACTIVE", "PENDING_DUPLICATE_REVIEW", "DUPLICATE_BLOCKED"] },
      },
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
  } catch (error) {
    await prisma.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "BIOMETRIC_ENROLLMENT_REJECTED",
        entityAffected: "BENEFICIARY",
        recordId: beneficiary.beneficiaryId,
        ipAddress: clientIpAddress(req),
        details: {
          reason: error.code ?? "PROCESSOR_ERROR",
          processor: env.biometricProcessorMode,
          rawCaptureStored: false,
        },
      },
    });
    throw error;
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
  let enrollment;
  try {
    enrollment = await prisma.$transaction(async (tx) => {
      await acquireBiometricEnrollmentLock(tx);
      const now = new Date();
      const currentConsent = await activeConsentOrThrow(
        beneficiary.beneficiaryId,
        consent.consentId,
        tx,
      );
      const existing = await tx.biometricData.findUnique({
        where: { beneficiaryId: beneficiary.beneficiaryId },
        select: { biometricId: true, dataStatus: true },
      });
      if (requireExistingProfile && !existing) {
        throw new AppError(404, "BIOMETRIC_PROFILE_NOT_FOUND", "No biometric profile exists to re-enroll.");
      }
      if (!requireExistingProfile && existing) {
        throw new AppError(409, "BIOMETRIC_PROFILE_ALREADY_EXISTS", "Use the re-enrollment endpoint to replace an existing profile.");
      }
      if (["PENDING_DUPLICATE_REVIEW", "DUPLICATE_BLOCKED"].includes(existing?.dataStatus)) {
        throw new AppError(
          409,
          "BIOMETRIC_DUPLICATE_REVIEW_UNRESOLVED",
          "This biometric profile has an unresolved duplicate decision and cannot be replaced.",
        );
      }

      const comparisonProfiles = await tx.biometricData.findMany({
        where: duplicateScanWhere(beneficiary.beneficiaryId, processing.model, now),
        select: {
          biometricId: true,
          beneficiaryId: true,
          consentId: true,
          faceEmbedding: true,
        },
      });
      const duplicate = findBiometricDuplicateMatch(processing.embedding, comparisonProfiles);
      const profileData = {
        enrolledById: req.auth.userId,
        consentId: currentConsent.consentId,
        faceEmbedding: encryptedTemplate,
        insightfaceModel: processing.model,
        dataStatus: duplicate ? "PENDING_DUPLICATE_REVIEW" : "ACTIVE",
        livenessScore: processing.livenessScore,
        livenessPassed: true,
        verificationCount: 0,
        lastVerifiedAt: null,
      };
      const profile = existing
        ? await tx.biometricData.update({
            where: { biometricId: existing.biometricId },
            data: profileData,
            select: { biometricId: true },
          })
        : await tx.biometricData.create({
            data: { beneficiaryId: beneficiary.beneficiaryId, ...profileData },
            select: { biometricId: true },
          });
      const duplicateCase = duplicate
        ? await tx.biometricDuplicateCase.create({
            data: {
              candidateBeneficiaryId: beneficiary.beneficiaryId,
              matchedBeneficiaryId: duplicate.profile.beneficiaryId,
              candidateBiometricId: profile.biometricId,
              matchedBiometricId: duplicate.profile.biometricId,
              matchScore: duplicate.matchScore,
              matchThreshold: env.biometricMatchThreshold,
              detectedAt: now,
            },
            select: { duplicateCaseId: true, status: true, detectedAt: true },
          })
        : null;
      await tx.auditLog.create({
        data: {
          userId: req.auth.userId,
          action: duplicate
            ? "BIOMETRIC_POSSIBLE_DUPLICATE_FLAGGED"
            : existing ? "BIOMETRIC_PROFILE_REENROLLED" : "BIOMETRIC_PROFILE_ENROLLED",
          entityAffected: duplicate ? "BIOMETRIC_DUPLICATE_CASE" : "BIOMETRIC_DATA",
          recordId: duplicateCase?.duplicateCaseId ?? profile.biometricId,
          ipAddress: clientIpAddress(req),
          details: {
            beneficiaryId: beneficiary.beneficiaryId,
            consentId: currentConsent.consentId,
            biometricId: profile.biometricId,
            possibleDuplicate: Boolean(duplicate),
            model: processing.model,
            processor: processing.processor,
            livenessPassed: true,
            rawCaptureStored: false,
            templateEncrypted: true,
          },
        },
      });
      return { biometricId: profile.biometricId, duplicateCase };
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error.code === "P2034") {
      throw new AppError(
        409,
        "BIOMETRIC_ENROLLMENT_CONCURRENT_CHANGE",
        "Another biometric enrollment completed at the same time. Capture again so duplicate detection can use the latest profiles.",
      );
    }
    throw error;
  } finally {
    processing.embedding?.fill(0);
  }
  const profile = await prisma.biometricData.findUniqueOrThrow({
    where: { biometricId: enrollment.biometricId },
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
      duplicateReview: enrollment.duplicateCase
        ? {
            required: true,
            caseId: enrollment.duplicateCase.duplicateCaseId,
            status: enrollment.duplicateCase.status,
            detectedAt: enrollment.duplicateCase.detectedAt,
          }
        : { required: false },
    },
  });
}

export const enrollBiometricProfile = asyncHandler((req, res) => saveEnrollment(req, res, false));
export const reenrollBiometricProfile = asyncHandler((req, res) => saveEnrollment(req, res, true));

export const listBiometricDuplicateCases = asyncHandler(async (req, res) => {
  assertBiometricDuplicateReviewAllowed(req.staffUser);
  const { page, pageSize, status, barangayId } = req.validatedQuery;
  const scopeWhere = barangayId
    ? {
        OR: [
          { candidateBeneficiary: { barangayId } },
          { matchedBeneficiary: { barangayId } },
        ],
      }
    : {};
  const where = {
    ...scopeWhere,
    ...(status ? { status } : {}),
  };
  const [cases, total, statusGroups] = await Promise.all([
    prisma.biometricDuplicateCase.findMany({
      where,
      select: biometricDuplicateCasePublicSelect,
      orderBy: [{ detectedAt: "desc" }, { duplicateCaseId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.biometricDuplicateCase.count({ where }),
    prisma.biometricDuplicateCase.groupBy({
      by: ["status"],
      where: scopeWhere,
      _count: { _all: true },
    }),
  ]);
  return res.status(200).json({
    success: true,
    data: {
      cases: cases.map(biometricDuplicateCaseToResponse),
      summary: {
        matchingCaseCount: total,
        countsByStatus: Object.fromEntries(
          statusGroups.map((group) => [group.status, group._count._all]),
        ),
      },
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
  });
});

export const reviewBiometricDuplicateCase = asyncHandler(async (req, res) => {
  assertBiometricDuplicateReviewAllowed(req.staffUser);
  const { duplicateCaseId } = req.validatedParams;
  const { action, reviewNotes } = req.validatedBody;
  const duplicateCase = await prisma.$transaction(async (tx) => {
    const current = await tx.biometricDuplicateCase.findUnique({
      where: { duplicateCaseId },
      select: biometricDuplicateCasePublicSelect,
    });
    if (!current) {
      throw new AppError(404, "BIOMETRIC_DUPLICATE_CASE_NOT_FOUND", "Duplicate-review case was not found.");
    }
    if (current.status !== "PENDING") {
      throw new AppError(409, "BIOMETRIC_DUPLICATE_CASE_ALREADY_REVIEWED", "This duplicate-review case already has a final decision.");
    }
    const candidateEnrollment = current.candidateBiometricId
      ? await tx.biometricData.findUnique({
          where: { biometricId: current.candidateBiometricId },
          select: { enrolledById: true },
        })
      : null;
    assertIndependentBiometricDuplicateReviewer(req.auth.userId, candidateEnrollment?.enrolledById);

    const nextStatus = action === "CLEAR_AS_DISTINCT" ? "CLEARED" : "CONFIRMED";
    if (current.candidateBiometric?.dataStatus === "PENDING_DUPLICATE_REVIEW") {
      const consentStatus = consentEffectiveStatus(current.candidateBiometric.consent);
      const nextProfileStatus = action === "CONFIRM_DUPLICATE"
        ? "DUPLICATE_BLOCKED"
        : current.candidateBeneficiary.status !== "ACTIVE"
          ? "REVOKED"
          : consentStatus === "ACTIVE" ? "ACTIVE" : consentStatus === "EXPIRED" ? "EXPIRED" : "REVOKED";
      const profileUpdate = await tx.biometricData.updateMany({
        where: {
          biometricId: current.candidateBiometric.biometricId,
          dataStatus: "PENDING_DUPLICATE_REVIEW",
        },
        data: { dataStatus: nextProfileStatus },
      });
      if (profileUpdate.count !== 1) {
        throw new AppError(409, "BIOMETRIC_DUPLICATE_REVIEW_CONCURRENT_CHANGE", "The candidate profile changed during review. Reload the case.");
      }
    }

    const reviewedAt = new Date();
    const caseUpdate = await tx.biometricDuplicateCase.updateMany({
      where: { duplicateCaseId, status: "PENDING", reviewedById: null },
      data: {
        status: nextStatus,
        reviewedById: req.auth.userId,
        reviewedAt,
        reviewNotes,
      },
    });
    if (caseUpdate.count !== 1) {
      throw new AppError(409, "BIOMETRIC_DUPLICATE_REVIEW_CONCURRENT_CHANGE", "Another reviewer completed this case. Reload the register.");
    }
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: action === "CLEAR_AS_DISTINCT"
          ? "BIOMETRIC_DUPLICATE_CASE_CLEARED"
          : "BIOMETRIC_DUPLICATE_CASE_CONFIRMED",
        entityAffected: "BIOMETRIC_DUPLICATE_CASE",
        recordId: duplicateCaseId,
        ipAddress: clientIpAddress(req),
        details: {
          candidateBeneficiaryId: current.candidateBeneficiaryId,
          matchedBeneficiaryId: current.matchedBeneficiaryId,
          decision: nextStatus,
          reviewNotes,
        },
      },
    });
    return tx.biometricDuplicateCase.findUniqueOrThrow({
      where: { duplicateCaseId },
      select: biometricDuplicateCasePublicSelect,
    });
  }, { isolationLevel: "Serializable" });

  return res.status(200).json({
    success: true,
    data: { duplicateCase: biometricDuplicateCaseToResponse(duplicateCase) },
  });
});

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
