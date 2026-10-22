import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
import { previewImport, confirmImport, startImport, listImports, getImport, getImportResults, resumeImport } from "./staffImport.controller.js";
import { previewStaffImportSchema, confirmStaffImportSchema, startStaffImportSchema, staffImportIdSchema } from "./staffImport.schemas.js";
import {
  createStaffUser,
  deleteStaffUser,
  getStaffUser,
  getStaffEmailDeliveries,
  listStaffUsers,
  resetStaffTotp,
  restoreStaffUser,
  updateStaffUser,
} from "./user.controller.js";
import {
  createStaffUserSchema,
  deleteStaffUserSchema,
  resetStaffTotpSchema,
  staffUserListQuerySchema,
  updateStaffUserSchema,
  userIdSchema,
} from "./user.schemas.js";

const userRoutes = Router();

userRoutes.use(authenticateStaff, authorizeRoles("SYSTEM_ADMIN"));
userRoutes.post("/import/preview", validateBody(previewStaffImportSchema), previewImport);
userRoutes.post("/import/confirm", validateBody(confirmStaffImportSchema), confirmImport);
userRoutes.post("/import/jobs", validateBody(startStaffImportSchema), startImport);
userRoutes.get("/import/jobs", listImports);
userRoutes.get("/import/jobs/:importId", validateParams(staffImportIdSchema), getImport);
userRoutes.get("/import/jobs/:importId/results", validateParams(staffImportIdSchema), getImportResults);
userRoutes.post("/import/jobs/:importId/resume", validateParams(staffImportIdSchema), resumeImport);
userRoutes.get("/", validateQuery(staffUserListQuerySchema), listStaffUsers);
userRoutes.post("/", validateBody(createStaffUserSchema), createStaffUser);
userRoutes.get("/:userId/email-deliveries", validateParams(userIdSchema), getStaffEmailDeliveries);
userRoutes.post("/:userId/totp/reset", validateParams(userIdSchema), validateBody(resetStaffTotpSchema), resetStaffTotp);
userRoutes.post("/:userId/restore", validateParams(userIdSchema), restoreStaffUser);
userRoutes.get("/:userId", validateParams(userIdSchema), getStaffUser);
userRoutes.patch("/:userId", validateParams(userIdSchema), validateBody(updateStaffUserSchema), updateStaffUser);
userRoutes.delete("/:userId", validateParams(userIdSchema), validateBody(deleteStaffUserSchema), deleteStaffUser);

export default userRoutes;
