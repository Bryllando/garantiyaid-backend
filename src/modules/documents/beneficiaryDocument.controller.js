import { createHash } from "node:crypto";
import { access, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import prisma from "../../lib/prisma.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import { getBeneficiaryOrThrow } from "../beneficiaries/beneficiary.service.js";
import { detectAllowedDocumentMimeType } from "./beneficiaryDocument.file.js";
import {
  assertBeneficiaryDocumentBarangayAccess,
  assertBeneficiaryDocumentReplacementAllowed,
  assertBeneficiaryDocumentReviewAllowed,
  assertBeneficiaryDocumentUploadAllowed,
} from "./beneficiaryDocument.policy.js";
import { beneficiaryDocumentMetadataSchema } from "./beneficiaryDocument.schemas.js";
import {
  assertBeneficiaryDocumentReplacementTransition,
  assertBeneficiaryDocumentReviewTransition,
  beneficiaryDocumentSelect,
  getBeneficiaryDocumentOrThrow,
  resolveBeneficiaryDocumentPath,
} from "./beneficiaryDocument.service.js";

async function removeUploadedFile(file) {
  if (!file?.path) {
    return;
  }

  try {
    await unlink(resolveBeneficiaryDocumentPath(path.relative(process.cwd(), file.path)));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Unable to clean up rejected beneficiary document upload.", error);
    }
  }
}

async function prepareUploadedDocument(req) {
  if (!req.file) {
    throw new AppError(400, "DOCUMENT_FILE_REQUIRED", "A beneficiary document file is required.");
  }

  const metadata = beneficiaryDocumentMetadataSchema.safeParse(req.body);
  if (!metadata.success) {
    throw new AppError(400, "VALIDATION_ERROR", "Request validation failed.", {
      fields: metadata.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const contents = await readFile(req.file.path);
  const detectedMimeType = detectAllowedDocumentMimeType(contents);

  if (!detectedMimeType) {
    throw new AppError(
      400,
      "INVALID_DOCUMENT_CONTENT",
      "The uploaded file content is not a supported PDF, JPG, or PNG document.",
    );
  }

  const originalFileName = path.basename(req.file.originalname).replace(/[\u0000-\u001f\u007f]/g, "");
  if (!originalFileName || originalFileName.length > 255) {
    throw new AppError(400, "INVALID_FILE_NAME", "Document file name must contain 1 to 255 characters.");
  }

  return {
    documentType: metadata.data.documentType,
    originalFileName,
    mimeType: detectedMimeType,
    fileSize: contents.length,
    checksum: createHash("sha256").update(contents).digest("hex"),
    filePath: path.relative(process.cwd(), req.file.path).split(path.sep).join("/"),
  };
}

export const uploadDocument = asyncHandler(async (req, res) => {
  try {
    assertBeneficiaryDocumentUploadAllowed(req.staffUser);
    const beneficiary = await getBeneficiaryOrThrow(
      req.validatedParams.beneficiaryId,
      req.staffUser,
    );
    assertBeneficiaryDocumentBarangayAccess(req.staffUser, beneficiary.barangayId);
    const uploadedDocument = await prepareUploadedDocument(req);

    const document = await prisma.$transaction(async (tx) => {
      const createdDocument = await tx.beneficiaryDocument.create({
        data: {
          beneficiaryId: beneficiary.beneficiaryId,
          uploadedById: req.auth.userId,
          ...uploadedDocument,
          reviewStatus: "SUBMITTED",
        },
        select: beneficiaryDocumentSelect,
      });

      await tx.auditLog.create({
        data: {
          userId: req.auth.userId,
          action: "BENEFICIARY_DOCUMENT_UPLOADED",
          entityAffected: "BENEFICIARY_DOCUMENT",
          recordId: createdDocument.documentId,
          ipAddress: clientIpAddress(req),
          details: {
            beneficiaryId: beneficiary.beneficiaryId,
            documentType: createdDocument.documentType,
            mimeType: createdDocument.mimeType,
            fileSize: createdDocument.fileSize,
          },
        },
      });

      return createdDocument;
    });

    return res.status(201).json({ success: true, data: { document } });
  } catch (error) {
    await removeUploadedFile(req.file);
    throw error;
  }
});

export const reviewDocument = asyncHandler(async (req, res) => {
  assertBeneficiaryDocumentReviewAllowed(req.staffUser);
  await getBeneficiaryOrThrow(req.validatedParams.beneficiaryId, req.staffUser);
  const existingDocument = await getBeneficiaryDocumentOrThrow(
    req.validatedParams.beneficiaryId,
    req.validatedParams.documentId,
  );
  const { decision, reason } = req.validatedBody;
  assertBeneficiaryDocumentReviewTransition(existingDocument, decision);

  const reviewedAt = new Date();
  const document = await prisma.$transaction(async (tx) => {
    const transition = await tx.beneficiaryDocument.updateMany({
      where: {
        documentId: existingDocument.documentId,
        beneficiaryId: existingDocument.beneficiaryId,
        reviewStatus: "SUBMITTED",
      },
      data: {
        reviewStatus: decision,
        reviewedById: req.auth.userId,
        reviewedAt,
        reviewNotes: decision === "REJECTED" ? reason : null,
      },
    });

    if (transition.count !== 1) {
      throw new AppError(
        409,
        "DOCUMENT_STATUS_CHANGED",
        "Document status changed while this request was being processed. Refresh and try again.",
      );
    }

    const updatedDocument = await tx.beneficiaryDocument.findUniqueOrThrow({
      where: { documentId: existingDocument.documentId },
      select: beneficiaryDocumentSelect,
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: decision === "ACCEPTED"
          ? "BENEFICIARY_DOCUMENT_ACCEPTED"
          : "BENEFICIARY_DOCUMENT_REJECTED",
        entityAffected: "BENEFICIARY_DOCUMENT",
        recordId: updatedDocument.documentId,
        ipAddress: clientIpAddress(req),
        details: {
          beneficiaryId: updatedDocument.beneficiaryId,
          documentType: updatedDocument.documentType,
          previousStatus: existingDocument.reviewStatus,
          reviewStatus: updatedDocument.reviewStatus,
          ...(reason ? { reason } : {}),
        },
      },
    });

    return updatedDocument;
  });

  res.status(200).json({ success: true, data: { document } });
});

export const replaceDocument = asyncHandler(async (req, res) => {
  try {
    assertBeneficiaryDocumentReplacementAllowed(req.staffUser);
    const beneficiary = await getBeneficiaryOrThrow(
      req.validatedParams.beneficiaryId,
      req.staffUser,
    );
    assertBeneficiaryDocumentBarangayAccess(req.staffUser, beneficiary.barangayId);
    const uploadedDocument = await prepareUploadedDocument(req);
    const rejectedDocument = await getBeneficiaryDocumentOrThrow(
      beneficiary.beneficiaryId,
      req.validatedParams.documentId,
    );
    assertBeneficiaryDocumentReplacementTransition(rejectedDocument, {
      beneficiaryId: beneficiary.beneficiaryId,
      documentType: uploadedDocument.documentType,
    });

    const document = await prisma.$transaction(async (tx) => {
      const transition = await tx.beneficiaryDocument.updateMany({
        where: {
          documentId: rejectedDocument.documentId,
          beneficiaryId: beneficiary.beneficiaryId,
          documentType: rejectedDocument.documentType,
          reviewStatus: "REJECTED",
        },
        data: { reviewStatus: "SUPERSEDED" },
      });

      if (transition.count !== 1) {
        throw new AppError(
          409,
          "DOCUMENT_STATUS_CHANGED",
          "Document status changed while this request was being processed. Refresh and try again.",
        );
      }

      const replacement = await tx.beneficiaryDocument.create({
        data: {
          beneficiaryId: beneficiary.beneficiaryId,
          uploadedById: req.auth.userId,
          ...uploadedDocument,
          reviewStatus: "SUBMITTED",
          replacesDocumentId: rejectedDocument.documentId,
        },
        select: beneficiaryDocumentSelect,
      });

      await tx.auditLog.create({
        data: {
          userId: req.auth.userId,
          action: "BENEFICIARY_DOCUMENT_REPLACED",
          entityAffected: "BENEFICIARY_DOCUMENT",
          recordId: replacement.documentId,
          ipAddress: clientIpAddress(req),
          details: {
            beneficiaryId: beneficiary.beneficiaryId,
            documentType: replacement.documentType,
            replacedDocumentId: rejectedDocument.documentId,
            replacementDocumentId: replacement.documentId,
            previousStatus: rejectedDocument.reviewStatus,
            replacedStatus: "SUPERSEDED",
            replacementStatus: replacement.reviewStatus,
          },
        },
      });

      return replacement;
    });

    return res.status(201).json({ success: true, data: { document } });
  } catch (error) {
    await removeUploadedFile(req.file);
    throw error;
  }
});

export const listDocuments = asyncHandler(async (req, res) => {
  const beneficiary = await getBeneficiaryOrThrow(
    req.validatedParams.beneficiaryId,
    req.staffUser,
  );
  assertBeneficiaryDocumentBarangayAccess(req.staffUser, beneficiary.barangayId);
  const documents = await prisma.beneficiaryDocument.findMany({
    where: { beneficiaryId: beneficiary.beneficiaryId },
    select: beneficiaryDocumentSelect,
    orderBy: { createdAt: "desc" },
  });

  res.status(200).json({ success: true, data: { documents } });
});

export const downloadDocument = asyncHandler(async (req, res, next) => {
  const beneficiary = await getBeneficiaryOrThrow(
    req.validatedParams.beneficiaryId,
    req.staffUser,
  );
  assertBeneficiaryDocumentBarangayAccess(req.staffUser, beneficiary.barangayId);
  const document = await getBeneficiaryDocumentOrThrow(
    req.validatedParams.beneficiaryId,
    req.validatedParams.documentId,
  );
  const fullPath = resolveBeneficiaryDocumentPath(document.filePath);

  try {
    await access(fullPath);
  } catch {
    throw new AppError(404, "DOCUMENT_FILE_NOT_FOUND", "Stored beneficiary document file was not found.");
  }

  await prisma.auditLog.create({
    data: {
      userId: req.auth.userId,
      action: "BENEFICIARY_DOCUMENT_DOWNLOADED",
      entityAffected: "BENEFICIARY_DOCUMENT",
      recordId: document.documentId,
      ipAddress: clientIpAddress(req),
      details: { beneficiaryId: document.beneficiaryId },
    },
  });

  res.type(document.mimeType);
  return res.download(fullPath, document.originalFileName, (error) => {
    if (error && !res.headersSent) {
      next(error);
    }
  });
});
