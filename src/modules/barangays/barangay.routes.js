import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
import { createBarangay, listBarangays, updateBarangay } from "./barangay.controller.js";
import {
  barangayIdSchema,
  barangayListQuerySchema,
  createBarangaySchema,
  updateBarangaySchema,
} from "./barangay.schemas.js";

const barangayRoutes = Router();

barangayRoutes.use(authenticateStaff);
barangayRoutes.get("/", validateQuery(barangayListQuerySchema), listBarangays);
barangayRoutes.post("/", authorizeRoles("SYSTEM_ADMIN"), validateBody(createBarangaySchema), createBarangay);
barangayRoutes.patch("/:barangayId", authorizeRoles("SYSTEM_ADMIN"), validateParams(barangayIdSchema), validateBody(updateBarangaySchema), updateBarangay);

export default barangayRoutes;
