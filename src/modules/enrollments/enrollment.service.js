import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { beneficiarySelect } from "../beneficiaries/beneficiary.service.js";
import { beneficiaryDocumentSelect } from "../documents/beneficiaryDocument.service.js";
import { programSelect } from "../programs/program.service.js";

const enrollmentStaffSelect = {
  userId: true,
  employeeId: true,
  username: true,
  fullName: true,
  role: true,
};

export const enrollmentSelect = {
  enrollmentId: true,
  beneficiaryId: true,
  programId: true,
  submittedById: true,
  enrollmentDate: true,
  status: true,
  reviewedById: true,
  reviewNotes: true,
  reviewedAt: true,
  eligibilitySnapshot: true,
  createdAt: true,
  updatedAt: true,
  beneficiary: {
    select: {
      ...beneficiarySelect,
      documents: {
        where: { reviewStatus: { not: "REMOVED" } },
        select: beneficiaryDocumentSelect,
        orderBy: { createdAt: "desc" },
      },
    },
  },
  program: { select: programSelect },
  submittedBy: { select: enrollmentStaffSelect },
  reviewedBy: { select: enrollmentStaffSelect },
};

export function enrollmentAccessWhere(staffUser) {
  if (staffUser.role !== "BARANGAY_FACILITATOR") {
    return {};
  }

  if (!staffUser.barangayId) {
    throw new AppError(
      403,
      "BARANGAY_ASSIGNMENT_REQUIRED",
      "This facilitator has no assigned barangay.",
    );
  }

  return { beneficiary: { barangayId: staffUser.barangayId } };
}

export function assertIndependentReviewer(enrollment, reviewerId) {
  if (enrollment.submittedById === reviewerId) {
    throw new AppError(403, "INDEPENDENT_REVIEW_REQUIRED", "A different authorized staff member must review an enrollment you submitted.");
  }
}

export async function getEnrollmentOrThrow(enrollmentId, staffUser, database = prisma) {
  const enrollment = await database.enrollment.findFirst({
    where: {
      enrollmentId,
      ...enrollmentAccessWhere(staffUser),
    },
    select: enrollmentSelect,
  });

  if (!enrollment) {
    throw new AppError(404, "ENROLLMENT_NOT_FOUND", "Beneficiary enrollment was not found.");
  }

  return enrollment;
}

export function assertRequiredDocuments(program, documents, { acceptedOnly = false } = {}) {
  const allowedReviewStatuses = acceptedOnly
    ? new Set(["ACCEPTED"])
    : new Set(["SUBMITTED", "ACCEPTED"]);
  const available = documents.filter(document => allowedReviewStatuses.has(document.reviewStatus));
  const names = program.otherRequiredDocumentNames?.length ? program.otherRequiredDocumentNames
    : program.otherRequiredDocumentName ? [program.otherRequiredDocumentName] : [];
  const normalize = value => value?.trim().toLowerCase().replace(/\s+/g, " ");
  const missingOtherDocumentNames = program.requiredDocumentTypes.includes("OTHER")
    ? names.filter(name => !available.some(document => document.documentType === "OTHER" && normalize(document.documentName) === normalize(name))) : [];
  const missingDocumentTypes = program.requiredDocumentTypes.filter(
    documentType => documentType === "OTHER" && names.length ? missingOtherDocumentNames.length > 0 : !available.some(document => document.documentType === documentType),
  );

  if (missingDocumentTypes.length > 0) {
    throw new AppError(
      409,
      acceptedOnly ? "REQUIRED_DOCUMENTS_NOT_ACCEPTED" : "MISSING_REQUIRED_DOCUMENTS",
      acceptedOnly
        ? "DSWD must accept every program-required beneficiary document before enrollment approval."
        : "Upload submitted or accepted documents for every program-required type before enrollment submission.",
      acceptedOnly
        ? { unacceptedDocumentTypes: missingDocumentTypes, ...(missingOtherDocumentNames.length ? { missingOtherDocumentNames } : {}) }
        : { missingDocumentTypes, ...(missingOtherDocumentNames.length ? { missingOtherDocumentNames } : {}) },
    );
  }
}

export function assertProgramAcceptsEnrollment(program, now = new Date()) {
  if (program.status !== "ACTIVE") {
    throw new AppError(
      409,
      "PROGRAM_NOT_ACCEPTING_ENROLLMENTS",
      "Only active assistance programs accept beneficiary enrollments.",
    );
  }

  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (program.applicationStartDate && today < program.applicationStartDate) {
    throw new AppError(
      409,
      "PROGRAM_APPLICATION_NOT_STARTED",
      "The program application period has not started.",
    );
  }

  if (program.applicationEndDate && today > program.applicationEndDate) {
    throw new AppError(
      409,
      "PROGRAM_APPLICATION_CLOSED",
      "The program application period has ended.",
    );
  }
}

export function assertEnrollmentStatus(enrollment, allowedStatuses, action) {
  if (!allowedStatuses.includes(enrollment.status)) {
    throw new AppError(
      409,
      "INVALID_ENROLLMENT_TRANSITION",
      `${action} is not allowed while enrollment status is ${enrollment.status}.`,
    );
  }
}
