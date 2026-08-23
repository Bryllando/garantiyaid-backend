import { Router } from "express";

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

export default healthRoutes;
