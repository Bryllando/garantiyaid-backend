import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
import {
  activateProgram,
  cancelProgram,
  closeProgram,
  createCriterion,
  createProgram,
  deleteCriterion,
  getProgram,
  listPrograms,
  updateCriterion,
  updateProgram,
} from "./program.controller.js";
import {
  createProgramCriterionSchema,
  createProgramSchema,
  programCriterionParamsSchema,
  programIdSchema,
  programListQuerySchema,
  updateProgramCriterionSchema,
  updateProgramSchema,
} from "./program.schemas.js";
import { PROGRAM_MANAGE_ROLES, PROGRAM_READ_ROLES } from "./program.policy.js";

const programRoutes = Router();

programRoutes.use(authenticateStaff);
programRoutes.get(
  "/",
  authorizeRoles(...PROGRAM_READ_ROLES),
  validateQuery(programListQuerySchema),
  listPrograms,
);
programRoutes.post(
  "/",
  authorizeRoles(...PROGRAM_MANAGE_ROLES),
  validateBody(createProgramSchema),
  createProgram,
);
programRoutes.get(
  "/:programId",
  authorizeRoles(...PROGRAM_READ_ROLES),
  validateParams(programIdSchema),
  getProgram,
);
programRoutes.patch(
  "/:programId",
  authorizeRoles(...PROGRAM_MANAGE_ROLES),
  validateParams(programIdSchema),
  validateBody(updateProgramSchema),
  updateProgram,
);
programRoutes.post(
  "/:programId/activate",
  authorizeRoles(...PROGRAM_MANAGE_ROLES),
  validateParams(programIdSchema),
  activateProgram,
);
programRoutes.post(
  "/:programId/close",
  authorizeRoles(...PROGRAM_MANAGE_ROLES),
  validateParams(programIdSchema),
  closeProgram,
);
programRoutes.post(
  "/:programId/cancel",
  authorizeRoles(...PROGRAM_MANAGE_ROLES),
  validateParams(programIdSchema),
  cancelProgram,
);
programRoutes.post(
  "/:programId/criteria",
  authorizeRoles(...PROGRAM_MANAGE_ROLES),
  validateParams(programIdSchema),
  validateBody(createProgramCriterionSchema),
  createCriterion,
);
programRoutes.patch(
  "/:programId/criteria/:criterionId",
  authorizeRoles(...PROGRAM_MANAGE_ROLES),
  validateParams(programCriterionParamsSchema),
  validateBody(updateProgramCriterionSchema),
  updateCriterion,
);
programRoutes.delete(
  "/:programId/criteria/:criterionId",
  authorizeRoles(...PROGRAM_MANAGE_ROLES),
  validateParams(programCriterionParamsSchema),
  deleteCriterion,
);

export default programRoutes;
