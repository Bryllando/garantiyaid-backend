import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { validateBody, validateParams } from "../../middleware/validate.js";
import {
  downloadDocument,
  listDocuments,
  replaceDocument,
  reviewDocument,
  uploadDocument,
} from "./beneficiaryDocument.controller.js";
import {
  beneficiaryDocumentListParamsSchema,
  beneficiaryDocumentParamsSchema,
  beneficiaryDocumentReviewSchema,
} from "./beneficiaryDocument.schemas.js";
import { uploadBeneficiaryDocument } from "./beneficiaryDocument.upload.js";
import {
  BENEFICIARY_DOCUMENT_READ_ROLES,
  BENEFICIARY_DOCUMENT_REPLACEMENT_ROLES,
  BENEFICIARY_DOCUMENT_REVIEW_ROLES,
  BENEFICIARY_DOCUMENT_UPLOAD_ROLES,
} from "./beneficiaryDocument.policy.js";

const beneficiaryDocumentRoutes = Router({ mergeParams: true });

beneficiaryDocumentRoutes.use(authenticateStaff);
beneficiaryDocumentRoutes.get(
  "/",
  authorizeRoles(...BENEFICIARY_DOCUMENT_READ_ROLES),
  validateParams(beneficiaryDocumentListParamsSchema),
  listDocuments,
);
beneficiaryDocumentRoutes.post(
  "/",
  authorizeRoles(...BENEFICIARY_DOCUMENT_UPLOAD_ROLES),
  validateParams(beneficiaryDocumentListParamsSchema),
  uploadBeneficiaryDocument,
  uploadDocument,
);
beneficiaryDocumentRoutes.post(
  "/:documentId/review",
  authorizeRoles(...BENEFICIARY_DOCUMENT_REVIEW_ROLES),
  validateParams(beneficiaryDocumentParamsSchema),
  validateBody(beneficiaryDocumentReviewSchema),
  reviewDocument,
);
beneficiaryDocumentRoutes.post(
  "/:documentId/replacement",
  authorizeRoles(...BENEFICIARY_DOCUMENT_REPLACEMENT_ROLES),
  validateParams(beneficiaryDocumentParamsSchema),
  uploadBeneficiaryDocument,
  replaceDocument,
);
beneficiaryDocumentRoutes.get(
  "/:documentId/download",
  authorizeRoles(...BENEFICIARY_DOCUMENT_READ_ROLES),
  validateParams(beneficiaryDocumentParamsSchema),
  downloadDocument,
);

export default beneficiaryDocumentRoutes;
