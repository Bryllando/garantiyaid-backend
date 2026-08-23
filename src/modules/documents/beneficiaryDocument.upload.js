import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { BENEFICIARY_DOCUMENT_MAX_BYTES } from "./beneficiaryDocument.constants.js";

export const beneficiaryDocumentUploadDirectory = path.resolve(
  process.cwd(),
  "uploads",
  "beneficiary-documents",
);

mkdirSync(beneficiaryDocumentUploadDirectory, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, callback) {
    callback(null, beneficiaryDocumentUploadDirectory);
  },
  filename(req, file, callback) {
    callback(null, `${randomUUID()}.upload`);
  },
});

export const uploadBeneficiaryDocument = multer({
  storage,
  limits: {
    files: 1,
    fileSize: BENEFICIARY_DOCUMENT_MAX_BYTES,
  },
}).single("file");
