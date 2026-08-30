import { z } from "zod";

const optionalNullableText = (maxLength) => z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().trim().min(1).max(maxLength).nullable().optional(),
);

const optionalEmail = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().trim().toLowerCase().email().max(150).nullable().optional(),
);

const optionalContactNumber = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }

    const compact = value.trim().replace(/[\s()-]/g, "");
    if (!compact) {
      return null;
    }

    return /^09\d{9}$/.test(compact) ? `+63${compact.slice(1)}` : compact;
  },
  z.string().regex(
    /^\+639\d{9}$/,
    "Contact number must be a Philippine mobile number such as 09171234567 or +639171234567.",
  ).nullable().optional(),
);

const sex = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(["MALE", "FEMALE", "OTHER", "UNKNOWN"]),
);

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const birthDate = z.string().trim()
  .refine(isValidDateOnly, "Birth date must be a valid date in YYYY-MM-DD format.")
  .refine(
    (value) => value <= new Date().toISOString().slice(0, 10),
    "Birth date cannot be in the future.",
  )
  .transform((value) => new Date(`${value}T00:00:00.000Z`));

const beneficiaryStatus = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(["ACTIVE", "INACTIVE", "SUSPENDED"]),
);

const beneficiaryFields = {
  firstName: z.string().trim().min(1).max(100),
  middleName: optionalNullableText(100),
  lastName: z.string().trim().min(1).max(100),
  birthDate,
  sex,
  address: z.string().trim().min(1).max(2000),
  sitioPurok: optionalNullableText(120),
  barangayId: z.uuid().optional(),
  contactNumber: optionalContactNumber,
  email: optionalEmail,
  philsysNumber: optionalNullableText(50),
};

export const beneficiaryIdSchema = z.object({
  beneficiaryId: z.uuid(),
});

export const createBeneficiarySchema = z.object(beneficiaryFields).strict();

export const updateBeneficiarySchema = z.object({
  ...beneficiaryFields,
  status: beneficiaryStatus.optional(),
}).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field must be supplied.",
);

export const beneficiaryListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(100).optional(),
  ),
  barangayId: z.uuid().optional(),
  status: beneficiaryStatus.optional(),
}).strict();

const futureIsoDateTime = z.string().trim()
  .refine(
    (value) => (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      && !Number.isNaN(Date.parse(value))
    ),
    "Retention date must be a valid ISO 8601 date and time with a timezone.",
  )
  .transform((value) => new Date(value))
  .refine((value) => value > new Date(), "Retention date must be in the future.");

export const createBiometricConsentSchema = z.object({
  consentVersion: z.string().trim().min(1).max(20),
  consentGiven: z.boolean(),
  retentionUntil: futureIsoDateTime,
}).strict();
