import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { authorizeRoles } from "../../middleware/authorize.js";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate.js";
import { createBarangay, listBarangays, updateBarangay } from "./barangay.controller.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { previewBarangayImportSchema, confirmBarangayImportSchema } from "./barangayImport.schemas.js";
import { previewBarangayImport, confirmBarangayImport } from "./barangayImport.service.js";
import {
  barangayIdSchema,
  barangayListQuerySchema,
  createBarangaySchema,
  updateBarangaySchema,
} from "./barangay.schemas.js";

const barangayRoutes = Router();

barangayRoutes.use(authenticateStaff);
barangayRoutes.post("/import/preview", authorizeRoles("SYSTEM_ADMIN"), validateBody(previewBarangayImportSchema), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store").json({ success: true, data: await previewBarangayImport(req.auth.userId, req.validatedBody.rows) });
}));
barangayRoutes.post("/import/confirm", authorizeRoles("SYSTEM_ADMIN"), validateBody(confirmBarangayImportSchema), asyncHandler(async (req, res) => {
  res.status(201).set("Cache-Control", "no-store").json({ success: true, data: await confirmBarangayImport(req) });
}));
barangayRoutes.get("/", validateQuery(barangayListQuerySchema), listBarangays);
barangayRoutes.post("/", authorizeRoles("SYSTEM_ADMIN"), validateBody(createBarangaySchema), createBarangay);
barangayRoutes.patch("/:barangayId", authorizeRoles("SYSTEM_ADMIN"), validateParams(barangayIdSchema), validateBody(updateBarangaySchema), updateBarangay);

export default barangayRoutes;
