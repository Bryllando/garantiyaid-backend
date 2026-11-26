import { access } from "node:fs/promises";
import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { prepareUploadedDocument, removeUploadedFile } from "../documents/beneficiaryDocument.controller.js";
import { assertBeneficiaryDocumentReplacementTransition, resolveBeneficiaryDocumentPath } from "../documents/beneficiaryDocument.service.js";
import { lockMobileSession } from "./mobile.service.js";

// Only beneficiary-facing metadata; never expose file paths, hashes, or staff identities.
const mobileDocumentSelect = {
  documentId: true, documentType: true, documentName: true, originalFileName: true, mimeType: true, fileSize: true,
  reviewStatus: true, reviewedAt: true, reviewNotes: true, replacesDocumentId: true, createdAt: true,
};

function mobileDocument(document) {
  return {
    id: document.documentId, docType: document.documentType.toLowerCase(),
    documentName: document.documentName ?? null,
    originalName: document.originalFileName, mimeType: document.mimeType, sizeBytes: document.fileSize,
    status: ({ SUBMITTED: "received", ACCEPTED: "accepted", REJECTED: "rejected", SUPERSEDED: "superseded" })[document.reviewStatus],
    reviewNotes: document.reviewNotes, reviewedAt: document.reviewedAt,
    replacesDocumentId: document.replacesDocumentId, canReplace: document.reviewStatus === "REJECTED", createdAt: document.createdAt,
  };
}

export const listMobileDocumentRequirements = asyncHandler(async (req, res) => {
  const { page, pageSize } = req.validatedQuery;
  const where = { OR: [{ status: "ACTIVE" }, { status: "CLOSED", enrollments: { some: { beneficiaryId: req.mobileSession.account.beneficiaryId } } }] };
  const result = await prisma.$transaction(async tx => {
    const total = await tx.program.count({ where });
    const programs = await tx.program.findMany({ where, select: { programId: true, programCode: true, programName: true,
      status: true, requiredDocumentTypes: true, otherRequiredDocumentNames: true, otherRequiredDocumentName: true },
      orderBy: [{ programName: "asc" }, { programId: "asc" }], skip: (page - 1) * pageSize, take: pageSize });
    return { programs: programs.map(program => {
      const names = program.otherRequiredDocumentNames.length ? program.otherRequiredDocumentNames
        : program.otherRequiredDocumentName ? [program.otherRequiredDocumentName] : [];
      return { id: program.programId, code: program.programCode, name: program.programName, status: program.status.toLowerCase(),
        requirements: program.requiredDocumentTypes.flatMap(type => type === "OTHER" && names.length
          ? names.map(documentName => ({ docType: "other", documentName })) : [{ docType: type.toLowerCase(), documentName: null }]) };
    }), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  }, { isolationLevel: "RepeatableRead" });
  res.set("Cache-Control", "private, no-store").json({ success: true, data: result });
});

export const listMobileDocuments = asyncHandler(async (req, res) => {
  const documents = await prisma.beneficiaryDocument.findMany({
    where: { beneficiaryId: req.mobileSession.account.beneficiaryId, reviewStatus: { not: "REMOVED" } },
    select: mobileDocumentSelect, orderBy: [{ createdAt: "desc" }, { documentId: "desc" }],
  });
  res.json({ success: true, data: documents.map(mobileDocument) });
});

export const uploadMobileDocument = asyncHandler(async (req, res) => {
  let keepFile = false;
  try {
    const uploaded = await prepareUploadedDocument(req);
    const replacementId = req.validatedParams?.documentId;
    const result = await prisma.$transaction(async (tx) => {
      // Recheck revocation after receiving the file and serialize mobile retries for this account.
      const account = await lockMobileSession(tx, req.mobileSession);
      const beneficiaryId = account.beneficiaryId;
      if (replacementId) {
        const original = await tx.beneficiaryDocument.findFirst({ where: { documentId: replacementId, beneficiaryId } });
        if (!original) throw new AppError(404, "BENEFICIARY_DOCUMENT_NOT_FOUND", "Document not found.");
        if (original.documentType === "OTHER") {
          const normalize = value => value?.trim().toLowerCase().replace(/\s+/g, " ") ?? null;
          if (uploaded.documentName && normalize(uploaded.documentName) !== normalize(original.documentName)) {
            throw new AppError(409, "DOCUMENT_NAME_MISMATCH", "Replace the same named document; upload a different requirement separately.");
          }
          uploaded.documentName = original.documentName ?? null;
        }
        const existing = await tx.beneficiaryDocument.findUnique({ where: { replacesDocumentId: replacementId } });
        if (existing) {
          if (existing.reviewStatus === "REMOVED" || existing.checksum !== uploaded.checksum || existing.documentType !== uploaded.documentType) {
            throw new AppError(409, "DOCUMENT_STATUS_CHANGED", "This document already has a correction. Refresh your documents.");
          }
          return { document: existing, created: false };
        }
        assertBeneficiaryDocumentReplacementTransition(original, { beneficiaryId, documentType: uploaded.documentType });
        const changed = await tx.beneficiaryDocument.updateMany({
          where: { documentId: replacementId, beneficiaryId, reviewStatus: "REJECTED" }, data: { reviewStatus: "SUPERSEDED" },
        });
        if (changed.count !== 1) throw new AppError(409, "DOCUMENT_STATUS_CHANGED", "The review status changed. Refresh your documents.");
      } else {
        const existing = await tx.beneficiaryDocument.findFirst({
          where: { beneficiaryId, documentType: uploaded.documentType, documentName: uploaded.documentName, checksum: uploaded.checksum, reviewStatus: { notIn: ["SUPERSEDED", "REMOVED"] } },
          orderBy: { createdAt: "desc" },
        });
        if (existing) return { document: existing, created: false };
      }
      const document = await tx.beneficiaryDocument.create({ data: {
        ...uploaded, beneficiaryId, uploadedByBeneficiaryId: beneficiaryId,
        reviewStatus: "SUBMITTED", ...(replacementId ? { replacesDocumentId: replacementId } : {}),
      }, select: mobileDocumentSelect });
      await tx.auditLog.create({ data: {
        actorType: "BENEFICIARY", action: replacementId ? "MOBILE_DOCUMENT_REPLACED" : "MOBILE_DOCUMENT_UPLOADED",
        entityAffected: "BENEFICIARY_DOCUMENT", recordId: document.documentId,
        details: { source: "MOBILE_APP", beneficiaryId, documentType: document.documentType, ...(replacementId ? { replacesDocumentId: replacementId } : {}) },
      } });
      return { document, created: true };
    });
    keepFile = result.created;
    res.status(result.created ? 201 : 200).json({ success: true, data: mobileDocument(result.document) });
  } finally {
    if (!keepFile) await removeUploadedFile(req.file);
  }
});

export const downloadMobileDocument = asyncHandler(async (req, res, next) => {
  const document = await prisma.beneficiaryDocument.findFirst({
    where: { documentId: req.validatedParams.documentId, beneficiaryId: req.mobileSession.account.beneficiaryId, reviewStatus: { not: "REMOVED" } },
    select: { originalFileName: true, filePath: true, mimeType: true },
  });
  if (!document) throw new AppError(404, "BENEFICIARY_DOCUMENT_NOT_FOUND", "Document not found.");
  const file = resolveBeneficiaryDocumentPath(document.filePath);
  try { await access(file); } catch { throw new AppError(404, "DOCUMENT_FILE_NOT_FOUND", "The stored file is unavailable."); }
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", "private, no-store");
  res.type(document.mimeType);
  res.download(file, document.originalFileName, (error) => { if (error) next(error); });
});
