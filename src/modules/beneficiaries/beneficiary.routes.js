import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
import { biometricRateLimiter } from "../../middleware/rateLimit.js";
import {
  createBeneficiary,
  getBeneficiary,
  listBeneficiaries,
  recordBiometricConsent,
  updateBeneficiary,
} from "./beneficiary.controller.js";
import {
  beneficiaryIdSchema,
  beneficiaryListQuerySchema,
  createBeneficiarySchema,
  createBiometricConsentSchema,
  updateBeneficiarySchema,
} from "./beneficiary.schemas.js";
import {
  BENEFICIARY_CREATE_ROLES,
  BENEFICIARY_READ_ROLES,
  BENEFICIARY_UPDATE_ROLES,
  BIOMETRIC_CONSENT_RECORD_ROLES,
} from "./beneficiary.policy.js";
import {
  deleteBiometricProfile,
  enrollBiometricProfile,
  getBiometricStatus,
  listBiometricConsents,
  reenrollBiometricProfile,
  revokeBiometricConsent,
} from "../biometrics/biometric.controller.js";
import {
  BIOMETRIC_CONSENT_MANAGE_ROLES,
  BIOMETRIC_DELETE_ROLES,
  BIOMETRIC_ENROLL_ROLES,
  BIOMETRIC_READ_ROLES,
} from "../biometrics/biometric.policy.js";
import {
  biometricConsentListQuerySchema,
  biometricConsentParamsSchema,
  biometricEnrollmentSchema,
} from "../biometrics/biometric.schemas.js";
import { uploadBiometricCapture } from "../biometrics/biometric.upload.js";

const beneficiaryRoutes = Router();

beneficiaryRoutes.use(authenticateStaff);
beneficiaryRoutes.get(
  "/",
  authorizeRoles(...BENEFICIARY_READ_ROLES),
  validateQuery(beneficiaryListQuerySchema),
  listBeneficiaries,
);
beneficiaryRoutes.post(
  "/",
  authorizeRoles(...BENEFICIARY_CREATE_ROLES),
  validateBody(createBeneficiarySchema),
  createBeneficiary,
);
beneficiaryRoutes.get(
  "/:beneficiaryId",
  authorizeRoles(...BENEFICIARY_READ_ROLES),
  validateParams(beneficiaryIdSchema),
  getBeneficiary,
);
beneficiaryRoutes.patch(
  "/:beneficiaryId",
  authorizeRoles(...BENEFICIARY_UPDATE_ROLES),
  validateParams(beneficiaryIdSchema),
  validateBody(updateBeneficiarySchema),
  updateBeneficiary,
);
beneficiaryRoutes.post(
  "/:beneficiaryId/biometric-consents",
  authorizeRoles(...BIOMETRIC_CONSENT_RECORD_ROLES),
  validateParams(beneficiaryIdSchema),
  validateBody(createBiometricConsentSchema),
  recordBiometricConsent,
);
beneficiaryRoutes.get(
  "/:beneficiaryId/biometric-consents",
  authorizeRoles(...BIOMETRIC_READ_ROLES),
  validateParams(beneficiaryIdSchema),
  validateQuery(biometricConsentListQuerySchema),
  listBiometricConsents,
);
beneficiaryRoutes.post(
  "/:beneficiaryId/biometric-consents/:consentId/revoke",
  authorizeRoles(...BIOMETRIC_CONSENT_MANAGE_ROLES),
  biometricRateLimiter,
  validateParams(biometricConsentParamsSchema),
  revokeBiometricConsent,
);
beneficiaryRoutes.get(
  "/:beneficiaryId/biometrics/status",
  authorizeRoles(...BIOMETRIC_READ_ROLES),
  validateParams(beneficiaryIdSchema),
  getBiometricStatus,
);
beneficiaryRoutes.post(
  "/:beneficiaryId/biometrics/enroll",
  authorizeRoles(...BIOMETRIC_ENROLL_ROLES),
  biometricRateLimiter,
  validateParams(beneficiaryIdSchema),
  uploadBiometricCapture,
  validateBody(biometricEnrollmentSchema),
  enrollBiometricProfile,
);
beneficiaryRoutes.post(
  "/:beneficiaryId/biometrics/re-enroll",
  authorizeRoles(...BIOMETRIC_ENROLL_ROLES),
  biometricRateLimiter,
  validateParams(beneficiaryIdSchema),
  uploadBiometricCapture,
  validateBody(biometricEnrollmentSchema),
  reenrollBiometricProfile,
);
beneficiaryRoutes.delete(
  "/:beneficiaryId/biometrics",
  authorizeRoles(...BIOMETRIC_DELETE_ROLES),
  biometricRateLimiter,
  validateParams(beneficiaryIdSchema),
  deleteBiometricProfile,
);

export default beneficiaryRoutes;
