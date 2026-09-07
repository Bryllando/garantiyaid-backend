import { Router } from "express";
import { authenticateStaff } from "../../middleware/authenticate.js";
import { validateBody } from "../../middleware/validate.js";
import {
  authenticationRateLimiter,
  totpRateLimiter,
} from "../../middleware/rateLimit.js";
import {
  changeOwnPassword,
  confirmOwnTotpReplacement,
  confirmTotp,
  getOwnAccount,
  getCurrentStaff,
  login,
  logout,
  regenerateOwnRecoveryCodes,
  revokeOwnOtherSessions,
  setupTotp,
  startOwnTotpReplacement,
  updateOwnProfile,
} from "./auth.controller.js";
import {
  changeOwnPasswordSchema,
  confirmTotpReplacementSchema,
  confirmTotpSchema,
  loginSchema,
  reauthenticateAccountSchema,
  updateOwnProfileSchema,
} from "./auth.schemas.js";

const authRoutes = Router();

authRoutes.post("/login", authenticationRateLimiter, validateBody(loginSchema), login);
authRoutes.get("/me", authenticateStaff, getCurrentStaff);
authRoutes.post("/logout", authenticateStaff, logout);
authRoutes.get("/account", authenticateStaff, getOwnAccount);
authRoutes.patch("/account", authenticateStaff, validateBody(updateOwnProfileSchema), updateOwnProfile);
authRoutes.post("/account/password", authenticateStaff, totpRateLimiter, validateBody(changeOwnPasswordSchema), changeOwnPassword);
authRoutes.post("/account/recovery-codes", authenticateStaff, totpRateLimiter, validateBody(reauthenticateAccountSchema), regenerateOwnRecoveryCodes);
authRoutes.post("/account/totp-replacement", authenticateStaff, totpRateLimiter, validateBody(reauthenticateAccountSchema), startOwnTotpReplacement);
authRoutes.post("/account/totp-replacement/confirm", authenticateStaff, totpRateLimiter, validateBody(confirmTotpReplacementSchema), confirmOwnTotpReplacement);
authRoutes.post("/account/sessions/revoke-others", authenticateStaff, revokeOwnOtherSessions);
authRoutes.post("/totp/setup", totpRateLimiter, setupTotp);
authRoutes.post("/totp/confirm", totpRateLimiter, validateBody(confirmTotpSchema), confirmTotp);

export default authRoutes;
