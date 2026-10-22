import { Router } from "express";
import { authorizeRoles } from "../../middleware/authorize.js";
import { validateBody, validateParams } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { PROGRAM_MANAGE_ROLES } from "./program.policy.js";
import { previewProgramImportSchema, startProgramImportSchema, programImportIdSchema } from "./programImport.schemas.js";
import { previewProgramImport } from "./programImport.service.js";
import { startProgramImport, listProgramImports, getProgramImport, getProgramImportResults, resumeProgramImport } from "./programImportJob.service.js";

const routes = Router();
routes.use(authorizeRoles(...PROGRAM_MANAGE_ROLES));
const send = (action, status = 200) => asyncHandler(async (req, res) => {
  const data = await action(req);
  res.set("Cache-Control", "no-store").status(status).json({ success: true, data });
});
routes.post("/preview", validateBody(previewProgramImportSchema), send(req => previewProgramImport(req.staffUser, req.validatedBody.rows)));
routes.post("/jobs", validateBody(startProgramImportSchema), send(req => startProgramImport(req), 202));
routes.get("/jobs", send(async req => ({ imports: await listProgramImports(req.staffUser) })));
routes.get("/jobs/:importId", validateParams(programImportIdSchema), send(req => getProgramImport(req.staffUser, req.validatedParams.importId)));
routes.get("/jobs/:importId/results", validateParams(programImportIdSchema), send(req => getProgramImportResults(req.staffUser, req.validatedParams.importId)));
routes.post("/jobs/:importId/resume", validateParams(programImportIdSchema), send(req => resumeProgramImport(req.staffUser, req.validatedParams.importId)));
export default routes;
