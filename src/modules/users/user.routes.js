import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
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
userRoutes.get("/", validateQuery(staffUserListQuerySchema), listStaffUsers);
userRoutes.post("/", validateBody(createStaffUserSchema), createStaffUser);
userRoutes.get("/:userId/email-deliveries", validateParams(userIdSchema), getStaffEmailDeliveries);
userRoutes.post("/:userId/totp/reset", validateParams(userIdSchema), validateBody(resetStaffTotpSchema), resetStaffTotp);
userRoutes.post("/:userId/restore", validateParams(userIdSchema), restoreStaffUser);
userRoutes.get("/:userId", validateParams(userIdSchema), getStaffUser);
userRoutes.patch("/:userId", validateParams(userIdSchema), validateBody(updateStaffUserSchema), updateStaffUser);
userRoutes.delete("/:userId", validateParams(userIdSchema), validateBody(deleteStaffUserSchema), deleteStaffUser);

export default userRoutes;
