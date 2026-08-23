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
  createdAt: true,
  updatedAt: true,
  beneficiary: {
    select: {
      ...beneficiarySelect,
      documents: {
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

export async function getEnrollmentOrThrow(enrollmentId, staffUser) {
  const enrollment = await prisma.enrollment.findFirst({
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
  const availableTypes = new Set(
    documents
      .filter((document) => allowedReviewStatuses.has(document.reviewStatus))
      .map((document) => document.documentType),
  );
  const missingDocumentTypes = program.requiredDocumentTypes.filter(
    (documentType) => !availableTypes.has(documentType),
  );

  if (missingDocumentTypes.length > 0) {
    throw new AppError(
      409,
      acceptedOnly ? "REQUIRED_DOCUMENTS_NOT_ACCEPTED" : "MISSING_REQUIRED_DOCUMENTS",
      acceptedOnly
        ? "DSWD must accept every program-required beneficiary document before enrollment approval."
        : "Upload submitted or accepted documents for every program-required type before enrollment submission.",
      acceptedOnly
        ? { unacceptedDocumentTypes: missingDocumentTypes }
        : { missingDocumentTypes },
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
