import { z } from "zod";
import { loginPasswordSchema, newStaffPasswordSchema } from "./password.schemas.js";

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
  newPassword: newStaffPasswordSchema.optional(),
  totpCode: totpCode.optional(),
  recoveryCode: recoveryCode.optional(),
}).strict().superRefine((value, context) => {
  if (value.totpCode && value.recoveryCode) {
    context.addIssue({
      code: "custom",
      message: "Use either a TOTP code or a recovery code, not both.",
    });
  }

  if (value.newPassword && (value.totpCode || value.recoveryCode)) {
    context.addIssue({
      code: "custom",
      path: ["newPassword"],
      message: "Finish the password change before entering an authentication code.",
    });
  }
});

export const confirmTotpSchema = z.object({
  code: totpCode,
});
