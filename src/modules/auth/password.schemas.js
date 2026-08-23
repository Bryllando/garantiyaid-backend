import { z } from "zod";

function withinBcryptByteLimit(value) {
  return Buffer.byteLength(value, "utf8") <= 72;
}

const bcryptCompatiblePassword = z.string().max(128).refine(
  withinBcryptByteLimit,
  "Password must not exceed bcrypt's 72-byte UTF-8 limit.",
);

export const loginPasswordSchema = bcryptCompatiblePassword.min(8);
export const newStaffPasswordSchema = bcryptCompatiblePassword.min(
  12,
  "Staff passwords must contain at least 12 characters.",
);
