import { z } from "zod";
import { BENEFICIARY_DOCUMENT_TYPES } from "../documents/beneficiaryDocument.constants.js";

const programStatuses = ["DRAFT", "ACTIVE", "CLOSED", "CANCELLED"];
const criterionFields = ["AGE", "SEX", "BARANGAY_ID", "DOCUMENT_TYPE", "MANUAL_REVIEW"];
const criterionOperators = [
  "EQUALS",
  "NOT_EQUALS",
  "GREATER_THAN",
  "GREATER_THAN_OR_EQUAL",
  "LESS_THAN",
  "LESS_THAN_OR_EQUAL",
  "IN",
  "NOT_IN",
  "REQUIRED",
];

const optionalText = (maxLength) => z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().trim().min(1).max(maxLength).nullable().optional(),
);

const optionalMoney = z.preprocess(
  (value) => (value === "" ? null : value),
  z.coerce.number().finite().nonnegative().max(999_999_999_999.99).nullable().optional(),
);

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const optionalDateOnly = z.preprocess(
  (value) => (value === "" ? null : value),
  z.string().trim().refine(isValidDateOnly, "Date must use a valid YYYY-MM-DD value.")
    .transform((value) => new Date(`${value}T00:00:00.000Z`))
    .nullable()
    .optional(),
);

const requiredDocumentTypes = z.array(z.enum(BENEFICIARY_DOCUMENT_TYPES)).max(20)
  .transform((values) => [...new Set(values)]);

const programFields = {
  programName: z.string().trim().min(1).max(150),
  programCode: z.string().trim().toUpperCase().min(3).max(30).regex(/^[A-Z0-9-]+$/),
  programType: z.string().trim().toUpperCase().min(2).max(20).regex(/^[A-Z0-9_]+$/),
  description: optionalText(5000),
  grantAmount: optionalMoney,
  budgetAmount: optionalMoney,
  applicationStartDate: optionalDateOnly,
  applicationEndDate: optionalDateOnly,
  requiredDocumentTypes: requiredDocumentTypes.optional(),
};

export const createProgramSchema = z.object(programFields).strict();
export const updateProgramSchema = z.object(programFields).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one program field must be supplied.",
);

export const programIdSchema = z.object({
  programId: z.uuid(),
}).strict();

export const programCriterionParamsSchema = z.object({
  programId: z.uuid(),
  criterionId: z.uuid(),
}).strict();

export const programListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(programStatuses).optional(),
  search: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(100).optional(),
  ),
}).strict();

const criterionFieldsSchema = {
  criterionName: z.string().trim().min(1).max(100),
  fieldName: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(criterionFields),
  ),
  operator: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
    z.enum(criterionOperators),
  ),
  expectedValue: z.json(),
  isRequired: z.boolean().optional(),
};

const sexValues = ["MALE", "FEMALE", "OTHER", "UNKNOWN"];
const equalityOperators = ["EQUALS", "NOT_EQUALS", "IN", "NOT_IN"];
const ageOperators = [...equalityOperators, "GREATER_THAN", "GREATER_THAN_OR_EQUAL", "LESS_THAN", "LESS_THAN_OR_EQUAL"];

function normalizeExpectedValue(fieldName, expectedValue) {
  if (fieldName === "SEX" || fieldName === "DOCUMENT_TYPE") {
    return Array.isArray(expectedValue)
      ? expectedValue.map((value) => typeof value === "string" ? value.trim().toUpperCase() : value)
      : typeof expectedValue === "string" ? expectedValue.trim().toUpperCase() : expectedValue;
  }
  if (fieldName === "BARANGAY_ID") {
    return Array.isArray(expectedValue)
      ? expectedValue.map((value) => typeof value === "string" ? value.trim() : value)
      : typeof expectedValue === "string" ? expectedValue.trim() : expectedValue;
  }
  return expectedValue;
}

function criterionIssue(value) {
  const { fieldName, operator } = value;
  const expectedValue = normalizeExpectedValue(fieldName, value.expectedValue);
  const expectsArray = ["IN", "NOT_IN"].includes(operator);
  const hasUniqueValues = (items) => new Set(items).size === items.length;

  if (fieldName === "AGE") {
    if (!ageOperators.includes(operator)) return "Age criteria must use a numeric comparison or list operator.";
    const values = expectsArray ? expectedValue : [expectedValue];
    if (
      !Array.isArray(values)
      || values.length < 1
      || values.length > 20
      || !values.every((item) => Number.isInteger(item) && item >= 0 && item <= 150)
      || (expectsArray && !Array.isArray(expectedValue))
      || (!expectsArray && Array.isArray(expectedValue))
    ) return "Age criteria require an integer from 0 to 150, or a unique list of those ages for IN and NOT IN.";
    if (!hasUniqueValues(values)) return "Criterion lists cannot contain duplicate values.";
    return null;
  }

  if (fieldName === "SEX") {
    if (!equalityOperators.includes(operator)) return "Sex criteria support Equals, Not equals, In, or Not in.";
    const values = expectsArray ? expectedValue : [expectedValue];
    if (
      !Array.isArray(values)
      || values.length < 1
      || values.length > sexValues.length
      || !values.every((item) => sexValues.includes(item))
      || (expectsArray && !Array.isArray(expectedValue))
      || (!expectsArray && Array.isArray(expectedValue))
    ) return "Sex criteria must use MALE, FEMALE, OTHER, or UNKNOWN.";
    if (!hasUniqueValues(values)) return "Criterion lists cannot contain duplicate values.";
    return null;
  }

  if (fieldName === "BARANGAY_ID") {
    if (!equalityOperators.includes(operator)) return "Barangay criteria support Equals, Not equals, In, or Not in.";
    const values = expectsArray ? expectedValue : [expectedValue];
    if (
      !Array.isArray(values)
      || values.length < 1
      || values.length > 50
      || !values.every((item) => z.uuid().safeParse(item).success)
      || (expectsArray && !Array.isArray(expectedValue))
      || (!expectsArray && Array.isArray(expectedValue))
    ) return "Barangay criteria require a UUID, or a unique UUID list for IN and NOT IN.";
    if (!hasUniqueValues(values)) return "Criterion lists cannot contain duplicate values.";
    return null;
  }

  if (fieldName === "DOCUMENT_TYPE") {
    if (operator !== "REQUIRED") return "Document criteria must use the Required operator.";
    if (!BENEFICIARY_DOCUMENT_TYPES.includes(expectedValue)) return "Select an approved beneficiary document type.";
    return null;
  }

  if (fieldName === "MANUAL_REVIEW") {
    if (operator !== "REQUIRED" || expectedValue !== true) return "Manual-review criteria must use Required with a true value.";
    return null;
  }

  return "Unsupported eligibility criterion.";
}

function normalizeCriterion(value) {
  return { ...value, expectedValue: normalizeExpectedValue(value.fieldName, value.expectedValue) };
}

export const createProgramCriterionSchema = z.object(criterionFieldsSchema).strict()
  .transform(normalizeCriterion)
  .superRefine((value, context) => {
    const message = criterionIssue(value);
    if (message) context.addIssue({ code: "custom", path: ["expectedValue"], message });
  });

export const updateProgramCriterionSchema = z.object(criterionFieldsSchema).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one criterion field must be supplied.",
);
