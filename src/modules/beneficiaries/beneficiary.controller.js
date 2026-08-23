import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import {
  assertNoPotentialDuplicateBeneficiary,
  beneficiarySelect,
  getBeneficiaryOrThrow,
} from "./beneficiary.service.js";
import {
  assertBeneficiaryUpdateAllowed,
  resolveBeneficiaryCreateBarangay,
  resolveBeneficiaryListBarangay,
} from "./beneficiary.policy.js";
import { assertBiometricConsentManageAllowed } from "../biometrics/biometric.policy.js";

async function ensureActiveBarangay(barangayId) {
  const barangay = await prisma.barangay.findUnique({
    where: { barangayId },
    select: { barangayId: true, isActive: true },
  });

  if (!barangay) {
    throw new AppError(404, "BARANGAY_NOT_FOUND", "Barangay was not found.");
  }

  if (!barangay.isActive) {
    throw new AppError(400, "BARANGAY_INACTIVE", "Beneficiaries cannot be assigned to an inactive barangay.");
  }
}

export const createBeneficiary = asyncHandler(async (req, res) => {
  const barangayId = resolveBeneficiaryCreateBarangay(
    req.staffUser,
    req.validatedBody.barangayId,
  );
  await ensureActiveBarangay(barangayId);
  await assertNoPotentialDuplicateBeneficiary({
    ...req.validatedBody,
    barangayId,
  });

  const beneficiary = await prisma.$transaction(async (tx) => {
    const createdBeneficiary = await tx.beneficiary.create({
      data: { ...req.validatedBody, barangayId },
      select: beneficiarySelect,
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "BENEFICIARY_CREATED",
        entityAffected: "BENEFICIARY",
        recordId: createdBeneficiary.beneficiaryId,
        ipAddress: clientIpAddress(req),
        details: { source: "STAFF_WEB" },
      },
    });

    return tx.beneficiary.findUniqueOrThrow({
      where: { beneficiaryId: createdBeneficiary.beneficiaryId },
      select: beneficiarySelect,
    });
  });

  res.status(201).json({ success: true, data: { beneficiary } });
});

export const listBeneficiaries = asyncHandler(async (req, res) => {
  const { page, pageSize, search, barangayId, status } = req.validatedQuery;
  const scopedBarangayId = resolveBeneficiaryListBarangay(req.staffUser, barangayId);
  const where = {
    ...(scopedBarangayId ? { barangayId: scopedBarangayId } : {}),
    ...(status ? { status } : {}),
    ...(search ? {
      OR: [
        { firstName: { contains: search, mode: "insensitive" } },
        { lastName: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { philsysNumber: { contains: search, mode: "insensitive" } },
      ],
    } : {}),
  };

  const [beneficiaries, total] = await Promise.all([
    prisma.beneficiary.findMany({
      where,
      select: beneficiarySelect,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.beneficiary.count({ where }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      beneficiaries,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
  });
});

export const getBeneficiary = asyncHandler(async (req, res) => {
  const beneficiary = await getBeneficiaryOrThrow(
    req.validatedParams.beneficiaryId,
    req.staffUser,
  );

  res.status(200).json({ success: true, data: { beneficiary } });
});

export const updateBeneficiary = asyncHandler(async (req, res) => {
  const existingBeneficiary = await getBeneficiaryOrThrow(
    req.validatedParams.beneficiaryId,
    req.staffUser,
  );
  assertBeneficiaryUpdateAllowed(req.staffUser, req.validatedBody);

  if (req.validatedBody.barangayId) {
    await ensureActiveBarangay(req.validatedBody.barangayId);
  }

  await assertNoPotentialDuplicateBeneficiary({
    ...existingBeneficiary,
    ...req.validatedBody,
    beneficiaryId: existingBeneficiary.beneficiaryId,
  });

  const beneficiary = await prisma.$transaction(async (tx) => {
    const updatedBeneficiary = await tx.beneficiary.update({
      where: { beneficiaryId: existingBeneficiary.beneficiaryId },
      data: req.validatedBody,
      select: beneficiarySelect,
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "BENEFICIARY_UPDATED",
        entityAffected: "BENEFICIARY",
        recordId: updatedBeneficiary.beneficiaryId,
        ipAddress: clientIpAddress(req),
        details: { changedFields: Object.keys(req.validatedBody) },
      },
    });

    return updatedBeneficiary;
  });

  res.status(200).json({ success: true, data: { beneficiary } });
});

export const recordBiometricConsent = asyncHandler(async (req, res) => {
  assertBiometricConsentManageAllowed(req.staffUser);
  const beneficiary = await getBeneficiaryOrThrow(
    req.validatedParams.beneficiaryId,
    req.staffUser,
  );

  const consent = await prisma.$transaction(async (tx) => {
    const revokedConsents = await tx.biometricConsent.updateMany({
      where: {
        beneficiaryId: beneficiary.beneficiaryId,
        consentGiven: true,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    const revokedProfiles = await tx.biometricData.updateMany({
      where: { beneficiaryId: beneficiary.beneficiaryId, dataStatus: "ACTIVE" },
      data: { dataStatus: "REVOKED" },
    });

    const recordedConsent = await tx.biometricConsent.create({
      data: {
        beneficiaryId: beneficiary.beneficiaryId,
        recordedById: req.auth.userId,
        consentedAt: new Date(),
        ...req.validatedBody,
      },
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "BIOMETRIC_CONSENT_RECORDED",
        entityAffected: "BIOMETRIC_CONSENT",
        recordId: recordedConsent.consentId,
        ipAddress: clientIpAddress(req),
        details: {
          consentGiven: req.validatedBody.consentGiven,
          consentVersion: req.validatedBody.consentVersion,
          priorConsentCountRevoked: revokedConsents.count,
          priorBiometricProfileRevoked: revokedProfiles.count === 1,
          rawCaptureStored: false,
        },
      },
    });

    return recordedConsent;
  });

  res.status(201).json({
    success: true,
    data: {
      consent: { ...consent, consentStatus: consent.consentGiven ? "ACTIVE" : "DECLINED" },
      biometricEnrollmentRequired: consent.consentGiven,
    },
  });
});
