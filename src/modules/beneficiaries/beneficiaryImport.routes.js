import { Router } from "express";
import { authorizeRoles } from "../../middleware/authorize.js";
import { validateBody, validateParams } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { BENEFICIARY_CREATE_ROLES } from "./beneficiary.policy.js";
import { previewBeneficiaryImportSchema, startBeneficiaryImportSchema, beneficiaryImportIdSchema } from "./beneficiaryImport.schemas.js";
import { previewBeneficiaryImport } from "./beneficiaryImport.service.js";
import { startBeneficiaryImport, listBeneficiaryImports, getBeneficiaryImport, getBeneficiaryImportResults, resumeBeneficiaryImport } from "./beneficiaryImportJob.service.js";

const routes = Router();
routes.use(authorizeRoles(...BENEFICIARY_CREATE_ROLES));
const send = (action, status = 200) => asyncHandler(async (req, res) => {
  const data = await action(req);
  res.set("Cache-Control", "no-store").status(status).json({ success: true, data });
});
routes.post("/preview", validateBody(previewBeneficiaryImportSchema), send(req => previewBeneficiaryImport(req.staffUser, req.validatedBody.rows)));
routes.post("/jobs", validateBody(startBeneficiaryImportSchema), send(req => startBeneficiaryImport(req), 202));
routes.get("/jobs", send(async req => ({ imports: await listBeneficiaryImports(req.staffUser) })));
routes.get("/jobs/:importId", validateParams(beneficiaryImportIdSchema), send(req => getBeneficiaryImport(req.staffUser, req.validatedParams.importId)));
routes.get("/jobs/:importId/results", validateParams(beneficiaryImportIdSchema), send(req => getBeneficiaryImportResults(req.staffUser, req.validatedParams.importId)));
routes.post("/jobs/:importId/resume", validateParams(beneficiaryImportIdSchema), send(req => resumeBeneficiaryImport(req.staffUser, req.validatedParams.importId)));
export default routes;
