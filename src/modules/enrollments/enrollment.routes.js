import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
import {
  approveEnrollment,
  getEnrollment,
  listEnrollments,
  rejectEnrollment,
  requestEnrollmentCorrection,
  resubmitEnrollment,
  startEnrollmentReview,
  submitEnrollment,
} from "./enrollment.controller.js";
import {
  enrollmentApprovalSchema,
  enrollmentDecisionSchema,
  enrollmentIdSchema,
  enrollmentListQuerySchema,
  programEnrollmentParamsSchema,
  submitEnrollmentSchema,
} from "./enrollment.schemas.js";
import {
  ENROLLMENT_READ_ROLES,
  ENROLLMENT_REVIEW_ROLES,
  ENROLLMENT_SUBMIT_ROLES,
} from "./enrollment.policy.js";

export const programEnrollmentRoutes = Router({ mergeParams: true });
programEnrollmentRoutes.use(authenticateStaff, authorizeRoles(...ENROLLMENT_SUBMIT_ROLES));
programEnrollmentRoutes.post(
  "/",
  validateParams(programEnrollmentParamsSchema),
  validateBody(submitEnrollmentSchema),
  submitEnrollment,
);

const enrollmentRoutes = Router();
enrollmentRoutes.use(authenticateStaff);
enrollmentRoutes.get(
  "/",
  authorizeRoles(...ENROLLMENT_READ_ROLES),
  validateQuery(enrollmentListQuerySchema),
  listEnrollments,
);
enrollmentRoutes.get(
  "/:enrollmentId",
  authorizeRoles(...ENROLLMENT_READ_ROLES),
  validateParams(enrollmentIdSchema),
  getEnrollment,
);
enrollmentRoutes.post(
  "/:enrollmentId/start-review",
  authorizeRoles(...ENROLLMENT_REVIEW_ROLES),
  validateParams(enrollmentIdSchema),
  startEnrollmentReview,
);
enrollmentRoutes.post(
  "/:enrollmentId/request-correction",
  authorizeRoles(...ENROLLMENT_REVIEW_ROLES),
  validateParams(enrollmentIdSchema),
  validateBody(enrollmentDecisionSchema),
  requestEnrollmentCorrection,
);
enrollmentRoutes.post(
  "/:enrollmentId/approve",
  authorizeRoles(...ENROLLMENT_REVIEW_ROLES),
  validateParams(enrollmentIdSchema),
  validateBody(enrollmentApprovalSchema),
  approveEnrollment,
);
enrollmentRoutes.post(
  "/:enrollmentId/reject",
  authorizeRoles(...ENROLLMENT_REVIEW_ROLES),
  validateParams(enrollmentIdSchema),
  validateBody(enrollmentDecisionSchema),
  rejectEnrollment,
);
enrollmentRoutes.post(
  "/:enrollmentId/resubmit",
  authorizeRoles(...ENROLLMENT_SUBMIT_ROLES),
  validateParams(enrollmentIdSchema),
  resubmitEnrollment,
);

export default enrollmentRoutes;
