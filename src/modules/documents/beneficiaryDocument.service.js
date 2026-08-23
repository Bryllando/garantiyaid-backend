import path from "node:path";
import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { beneficiaryDocumentUploadDirectory } from "./beneficiaryDocument.upload.js";

export const beneficiaryDocumentSelect = {
  documentId: true,
  beneficiaryId: true,
  documentType: true,
  originalFileName: true,
  mimeType: true,
  fileSize: true,
  checksum: true,
  reviewStatus: true,
  reviewedById: true,
  reviewedAt: true,
  reviewNotes: true,
  replacesDocumentId: true,
  createdAt: true,
  uploadedBy: {
    select: {
      userId: true,
      employeeId: true,
      username: true,
      fullName: true,
      role: true,
    },
  },
  reviewedBy: {
    select: {
      userId: true,
      employeeId: true,
      username: true,
      fullName: true,
      role: true,
    },
  },
};

export function assertBeneficiaryDocumentReviewTransition(document, decision) {
  if (!document || document.reviewStatus !== "SUBMITTED") {
    throw new AppError(
      409,
      "INVALID_DOCUMENT_REVIEW_TRANSITION",
      `Only submitted documents may be reviewed${document ? `; this document is ${document.reviewStatus}` : ""}.`,
    );
  }

  if (!(["ACCEPTED", "REJECTED"].includes(decision))) {
    throw new AppError(400, "INVALID_DOCUMENT_REVIEW_DECISION", "Document decision must be ACCEPTED or REJECTED.");
  }
}

export function assertBeneficiaryDocumentReplacementTransition(document, {
  beneficiaryId,
  documentType,
}) {
  if (document.beneficiaryId !== beneficiaryId) {
    throw new AppError(
      409,
      "DOCUMENT_BENEFICIARY_MISMATCH",
      "A replacement must belong to the same beneficiary as the rejected document.",
    );
  }

  if (document.documentType !== documentType) {
    throw new AppError(
      409,
      "DOCUMENT_TYPE_MISMATCH",
      "A replacement must use the same document type as the rejected document.",
    );
  }

  if (document.reviewStatus !== "REJECTED") {
    throw new AppError(
      409,
      "DOCUMENT_NOT_REPLACEABLE",
      `Only rejected documents may be replaced; this document is ${document.reviewStatus}.`,
    );
  }
}

export async function getBeneficiaryDocumentOrThrow(beneficiaryId, documentId) {
  const document = await prisma.beneficiaryDocument.findFirst({
    where: { beneficiaryId, documentId },
    select: {
      ...beneficiaryDocumentSelect,
      filePath: true,
    },
  });

  if (!document) {
    throw new AppError(404, "BENEFICIARY_DOCUMENT_NOT_FOUND", "Beneficiary document was not found.");
  }

  return document;
}

export function resolveBeneficiaryDocumentPath(storedPath) {
  const resolvedPath = path.resolve(process.cwd(), storedPath);
  const allowedPrefix = `${beneficiaryDocumentUploadDirectory}${path.sep}`;

  if (!resolvedPath.startsWith(allowedPrefix)) {
    throw new AppError(500, "INVALID_DOCUMENT_PATH", "Stored beneficiary document path is invalid.");
  }

  return resolvedPath;
}
