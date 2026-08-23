import { z } from "zod";
import { loginPasswordSchema } from "./password.schemas.js";

const identifier = z.string().trim().min(1).max(30).regex(
  /^[A-Za-z0-9._-]+$/,
  "Use a username or staff ID, not an email address.",
);
const totpCode = z.string().regex(/^\d{6}$/, "TOTP code must contain exactly six digits.");

export const loginSchema = z.object({
  identifier,
  password: loginPasswordSchema,
  totpCode: totpCode.optional(),
}).strict();

export const confirmTotpSchema = z.object({
  code: totpCode,
});
