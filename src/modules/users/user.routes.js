import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
import {
  createStaffUser,
  getStaffUser,
  listStaffUsers,
  updateStaffUser,
} from "./user.controller.js";
import {
  createStaffUserSchema,
  staffUserListQuerySchema,
  updateStaffUserSchema,
  userIdSchema,
} from "./user.schemas.js";

const userRoutes = Router();

userRoutes.use(authenticateStaff, authorizeRoles("SYSTEM_ADMIN"));
userRoutes.get("/", validateQuery(staffUserListQuerySchema), listStaffUsers);
userRoutes.post("/", validateBody(createStaffUserSchema), createStaffUser);
userRoutes.get("/:userId", validateParams(userIdSchema), getStaffUser);
userRoutes.patch("/:userId", validateParams(userIdSchema), validateBody(updateStaffUserSchema), updateStaffUser);

export default userRoutes;
