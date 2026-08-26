import { z } from "zod";
import { loginPasswordSchema } from "./password.schemas.js";

const identifier = z.string().trim().min(1).max(30).regex(
  /^[A-Za-z0-9._-]+$/,
  "Use a username or staff ID, not an email address.",
);
const totpCode = z.string().regex(/^\d{6}$/, "TOTP code must contain exactly six digits.");
const recoveryCode = z.string().trim().toUpperCase().max(19).refine(
  (value) => /^(?:[A-F0-9]{16}|(?:[A-F0-9]{4}-){3}[A-F0-9]{4})$/.test(value),
  "Recovery code must contain 16 hexadecimal characters.",
);

export const loginSchema = z.object({
  identifier,
  password: loginPasswordSchema,
  totpCode: totpCode.optional(),
  recoveryCode: recoveryCode.optional(),
}).strict().refine(
  (value) => !(value.totpCode && value.recoveryCode),
  { message: "Use either a TOTP code or a recovery code, not both." },
);

export const confirmTotpSchema = z.object({
  code: totpCode,
});
