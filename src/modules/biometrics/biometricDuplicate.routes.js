import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { biometricRateLimiter } from "../../middleware/rateLimit.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
import {
  listBiometricDuplicateCases,
  reviewBiometricDuplicateCase,
} from "./biometric.controller.js";
import { BIOMETRIC_DUPLICATE_REVIEW_ROLES } from "./biometric.policy.js";
import {
  biometricDuplicateCaseListQuerySchema,
  biometricDuplicateCaseParamsSchema,
  reviewBiometricDuplicateCaseSchema,
} from "./biometric.schemas.js";

const biometricDuplicateRoutes = Router();

biometricDuplicateRoutes.use(
  authenticateStaff,
  authorizeRoles(...BIOMETRIC_DUPLICATE_REVIEW_ROLES),
);
biometricDuplicateRoutes.get(
  "/",
  validateQuery(biometricDuplicateCaseListQuerySchema),
  listBiometricDuplicateCases,
);
biometricDuplicateRoutes.post(
  "/:duplicateCaseId/review",
  biometricRateLimiter,
  validateParams(biometricDuplicateCaseParamsSchema),
  validateBody(reviewBiometricDuplicateCaseSchema),
  reviewBiometricDuplicateCase,
);

export default biometricDuplicateRoutes;
