import { Router } from "express";
import { checkReadiness } from "../lib/readiness.js";

const healthRoutes = Router();

healthRoutes.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      service: "garantiyaid-backend",
      status: "ok",
      timestamp: new Date().toISOString(),
    },
  });
});

healthRoutes.get("/health/ready", async (_req, res) => {
  try {
    await checkReadiness();
    return res.status(200).json({ success: true, data: { status: "ready" } });
  } catch {
    return res.status(503).json({ success: false, error: { code: "SERVICE_NOT_READY", message: "Service dependencies are unavailable." } });
  }
});

export default healthRoutes;
