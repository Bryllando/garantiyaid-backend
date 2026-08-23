import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { validateBody } from "../../middleware/validate.js";
import {
  authenticationRateLimiter,
  totpRateLimiter,
} from "../../middleware/rateLimit.js";
import {
  confirmTotp,
  getCurrentStaff,
  login,
  logout,
  setupTotp,
} from "./auth.controller.js";
import { confirmTotpSchema, loginSchema } from "./auth.schemas.js";

const authRoutes = Router();

authRoutes.post("/login", authenticationRateLimiter, validateBody(loginSchema), login);
authRoutes.get("/me", authenticateStaff, getCurrentStaff);
authRoutes.post("/logout", authenticateStaff, logout);
authRoutes.post("/totp/setup", totpRateLimiter, setupTotp);
authRoutes.post("/totp/confirm", totpRateLimiter, validateBody(confirmTotpSchema), confirmTotp);

export default authRoutes;
