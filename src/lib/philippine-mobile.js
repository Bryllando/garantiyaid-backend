import { z } from "zod";

export const PHILIPPINE_MOBILE_ERROR = "Contact number must be an 11-digit Philippine mobile number such as 09171234567.";

function normalizePhilippineMobile(value, emptyValue) {
  if (typeof value !== "string") return value;
  const compact = value.trim().replace(/[\s()-]/g, "");
  if (!compact) return emptyValue;
  return /^09\d{9}$/.test(compact) ? `+63${compact.slice(1)}` : compact;
}

export function optionalPhilippineMobileSchema(emptyValue = null) {
  return z.preprocess(
    (value) => normalizePhilippineMobile(value, emptyValue),
    z.string().regex(/^\+639\d{9}$/, PHILIPPINE_MOBILE_ERROR).nullable().optional(),
  );
}
