import { asyncHandler } from "../../utils/asyncHandler.js";
import { previewStaffImport, confirmStaffImport } from "./staffImport.service.js";
import { startStaffImport, listStaffImports, getStaffImport, getStaffImportResults, resumeStaffImport } from "./staffImportJob.service.js";

export const previewImport = asyncHandler(async (req, res) => {
  const data = await previewStaffImport(req.auth.userId, req.validatedBody.rows);
  res.set("Cache-Control", "no-store").json({ success: true, data });
});

export const confirmImport = asyncHandler(async (req, res) => {
  const data = await confirmStaffImport(req);
  res.set("Cache-Control", "no-store").set("Idempotency-Replayed", String(data.replayed)).status(data.replayed ? 200 : 201).json({ success: true, data });
});

export const startImport = asyncHandler(async (req, res) => {
  const data = await startStaffImport(req);
  res.set("Cache-Control", "no-store").status(202).json({ success: true, data });
});
export const listImports = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store").json({ success: true, data: { imports: await listStaffImports(req.auth.userId) } });
});
export const getImport = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store").json({ success: true, data: await getStaffImport(req.auth.userId, req.validatedParams.importId) });
});
export const getImportResults = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store").json({ success: true, data: await getStaffImportResults(req.auth.userId, req.validatedParams.importId) });
});
export const resumeImport = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store").json({ success: true, data: await resumeStaffImport(req.auth.userId, req.validatedParams.importId) });
});
