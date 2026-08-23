import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { getBeneficiaryOrThrow } from "../beneficiaries/beneficiary.service.js";
import { getProgramOrThrow } from "../programs/program.service.js";
import {
  assertEnrollmentStatus,
  assertProgramAcceptsEnrollment,
  assertRequiredDocuments,
  enrollmentAccessWhere,
  enrollmentSelect,
  getEnrollmentOrThrow,
} from "./enrollment.service.js";

export const submitEnrollment = asyncHandler(async (req, res) => {
  const beneficiary = await getBeneficiaryOrThrow(
    req.validatedBody.beneficiaryId,
    req.staffUser,
  );
  if (beneficiary.status !== "ACTIVE") {
    throw new AppError(409, "BENEFICIARY_INACTIVE", "Only active beneficiary records can be submitted.");
  }

  const program = await getProgramOrThrow(req.validatedParams.programId, req.staffUser);
  assertProgramAcceptsEnrollment(program);

  const documents = await prisma.beneficiaryDocument.findMany({
    where: { beneficiaryId: beneficiary.beneficiaryId },
    select: { documentType: true, reviewStatus: true },
  });
  assertRequiredDocuments(program, documents);

  const duplicate = await prisma.enrollment.findUnique({
    where: {
      beneficiaryId_programId: {
        beneficiaryId: beneficiary.beneficiaryId,
        programId: program.programId,
      },
    },
    select: { enrollmentId: true, status: true },
  });
  if (duplicate) {
    throw new AppError(
      409,
      "BENEFICIARY_ALREADY_ENROLLED",
      `Beneficiary already has a ${duplicate.status} enrollment for this program.`,
    );
  }

  const enrollmentId = await prisma.$transaction(async (tx) => {
    const createdEnrollment = await tx.enrollment.create({
      data: {
        beneficiaryId: beneficiary.beneficiaryId,
        programId: program.programId,
        submittedById: req.auth.userId,
      },
      select: { enrollmentId: true, status: true },
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "ENROLLMENT_SUBMITTED",
        entityAffected: "ENROLLMENT",
        recordId: createdEnrollment.enrollmentId,
        ipAddress: clientIpAddress(req),
        details: {
          beneficiaryId: beneficiary.beneficiaryId,
          programId: program.programId,
          status: createdEnrollment.status,
        },
      },
    });

    return createdEnrollment.enrollmentId;
  });

  const enrollment = await prisma.enrollment.findUniqueOrThrow({
    where: { enrollmentId },
    select: enrollmentSelect,
  });

  res.status(201).json({ success: true, data: { enrollment } });
});

export const listEnrollments = asyncHandler(async (req, res) => {
  const { page, pageSize, status, programId, barangayId, search } = req.validatedQuery;
  if (
    req.staffUser.role === "BARANGAY_FACILITATOR"
    && barangayId
    && barangayId !== req.staffUser.barangayId
  ) {
    throw new AppError(403, "FORBIDDEN", "You can only view enrollments in your assigned barangay.");
  }

  const where = {
    ...enrollmentAccessWhere(req.staffUser),
    ...(status ? { status } : {}),
    ...(programId ? { programId } : {}),
    ...(barangayId && req.staffUser.role !== "BARANGAY_FACILITATOR"
      ? { beneficiary: { barangayId } }
      : {}),
    ...(search ? {
      beneficiary: {
        ...(req.staffUser.role === "BARANGAY_FACILITATOR"
          ? { barangayId: req.staffUser.barangayId }
          : barangayId
            ? { barangayId }
            : {}),
        OR: [
          { firstName: { contains: search, mode: "insensitive" } },
          { lastName: { contains: search, mode: "insensitive" } },
          { philsysNumber: { contains: search, mode: "insensitive" } },
        ],
      },
    } : {}),
  };

  const [enrollments, total] = await Promise.all([
    prisma.enrollment.findMany({
      where,
      select: enrollmentSelect,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.enrollment.count({ where }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      enrollments,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
  });
});

export const getEnrollment = asyncHandler(async (req, res) => {
  const enrollment = await getEnrollmentOrThrow(
    req.validatedParams.enrollmentId,
    req.staffUser,
  );
  res.status(200).json({ success: true, data: { enrollment } });
});

async function reviewEnrollment(req, res, {
  allowedStatuses,
  nextStatus,
  action,
  notes,
  recheckDocuments = false,
}) {
  const existingEnrollment = await getEnrollmentOrThrow(
    req.validatedParams.enrollmentId,
    req.staffUser,
  );
  assertEnrollmentStatus(existingEnrollment, allowedStatuses, action);

  if (recheckDocuments) {
    assertRequiredDocuments(
      existingEnrollment.program,
      existingEnrollment.beneficiary.documents,
      { acceptedOnly: true },
    );
  }

  const enrollmentId = await prisma.$transaction(async (tx) => {
    const transition = await tx.enrollment.updateMany({
      where: {
        enrollmentId: existingEnrollment.enrollmentId,
        status: { in: allowedStatuses },
      },
      data: {
        status: nextStatus,
        reviewedById: req.auth.userId,
        reviewedAt: new Date(),
        reviewNotes: notes ?? null,
      },
    });

    if (transition.count !== 1) {
      throw new AppError(
        409,
        "ENROLLMENT_STATUS_CHANGED",
        "Enrollment status changed while this request was being processed. Refresh and try again.",
      );
    }

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action,
        entityAffected: "ENROLLMENT",
        recordId: existingEnrollment.enrollmentId,
        ipAddress: clientIpAddress(req),
        details: {
          previousStatus: existingEnrollment.status,
          status: nextStatus,
          ...(notes ? { notes } : {}),
        },
      },
    });

    return existingEnrollment.enrollmentId;
  });

  const enrollment = await prisma.enrollment.findUniqueOrThrow({
    where: { enrollmentId },
    select: enrollmentSelect,
  });

  res.status(200).json({ success: true, data: { enrollment } });
}

export const startEnrollmentReview = asyncHandler((req, res) => reviewEnrollment(req, res, {
  allowedStatuses: ["PENDING"],
  nextStatus: "FOR_VALIDATION",
  action: "ENROLLMENT_REVIEW_STARTED",
}));

export const requestEnrollmentCorrection = asyncHandler((req, res) => reviewEnrollment(req, res, {
  allowedStatuses: ["FOR_VALIDATION"],
  nextStatus: "NEEDS_CORRECTION",
  action: "ENROLLMENT_CORRECTION_REQUESTED",
  notes: req.validatedBody.reason,
}));

export const approveEnrollment = asyncHandler((req, res) => reviewEnrollment(req, res, {
  allowedStatuses: ["FOR_VALIDATION"],
  nextStatus: "APPROVED",
  action: "ENROLLMENT_APPROVED",
  notes: req.validatedBody.remarks,
  recheckDocuments: true,
}));

export const rejectEnrollment = asyncHandler((req, res) => reviewEnrollment(req, res, {
  allowedStatuses: ["FOR_VALIDATION"],
  nextStatus: "REJECTED",
  action: "ENROLLMENT_REJECTED",
  notes: req.validatedBody.reason,
}));

export const resubmitEnrollment = asyncHandler(async (req, res) => {
  const existingEnrollment = await getEnrollmentOrThrow(
    req.validatedParams.enrollmentId,
    req.staffUser,
  );
  assertEnrollmentStatus(
    existingEnrollment,
    ["NEEDS_CORRECTION"],
    "ENROLLMENT_RESUBMITTED",
  );
  assertProgramAcceptsEnrollment(existingEnrollment.program);
  assertRequiredDocuments(
    existingEnrollment.program,
    existingEnrollment.beneficiary.documents,
  );

  const enrollmentId = await prisma.$transaction(async (tx) => {
    const transition = await tx.enrollment.updateMany({
      where: {
        enrollmentId: existingEnrollment.enrollmentId,
        status: "NEEDS_CORRECTION",
      },
      data: {
        status: "PENDING",
        submittedById: req.auth.userId,
        reviewedById: null,
        reviewedAt: null,
        reviewNotes: null,
      },
    });

    if (transition.count !== 1) {
      throw new AppError(
        409,
        "ENROLLMENT_STATUS_CHANGED",
        "Enrollment status changed while this request was being processed. Refresh and try again.",
      );
    }

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "ENROLLMENT_RESUBMITTED",
        entityAffected: "ENROLLMENT",
        recordId: existingEnrollment.enrollmentId,
        ipAddress: clientIpAddress(req),
        details: { previousStatus: existingEnrollment.status, status: "PENDING" },
      },
    });

    return existingEnrollment.enrollmentId;
  });

  const enrollment = await prisma.enrollment.findUniqueOrThrow({
    where: { enrollmentId },
    select: enrollmentSelect,
  });

  res.status(200).json({ success: true, data: { enrollment } });
});
