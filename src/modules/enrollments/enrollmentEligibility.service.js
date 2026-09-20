import { AppError } from "../../utils/AppError.js";
import { BENEFICIARY_DOCUMENT_TYPES } from "../documents/beneficiaryDocument.constants.js";

const AGE_OPERATORS = new Set([
  "EQUALS",
  "NOT_EQUALS",
  "GREATER_THAN",
  "GREATER_THAN_OR_EQUAL",
  "LESS_THAN",
  "LESS_THAN_OR_EQUAL",
  "IN",
  "NOT_IN",
]);
const VALUE_OPERATORS = new Set(["EQUALS", "NOT_EQUALS", "IN", "NOT_IN"]);
const LIST_OPERATORS = new Set(["IN", "NOT_IN"]);
const SEX_VALUES = new Set(["MALE", "FEMALE", "OTHER", "UNKNOWN"]);
const DOCUMENT_TYPES = new Set(BENEFICIARY_DOCUMENT_TYPES);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ELIGIBILITY_STATUSES = Object.freeze({
  ELIGIBLE: "ELIGIBLE",
  INELIGIBLE: "INELIGIBLE",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
});

export const ELIGIBILITY_OUTCOMES = Object.freeze({
  MET: "MET",
  NOT_MET: "NOT_MET",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
});

function invalidEligibilityData(message, details) {
  throw new AppError(409, "INVALID_ELIGIBILITY_DATA", message, details);
}

function invalidCriterion(criterion, message) {
  throw new AppError(
    409,
    "INVALID_PROGRAM_CRITERION",
    message,
    { criterionId: criterion?.criterionId ?? null },
  );
}

function dateOnlyParts(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    invalidEligibilityData(`${label} must be a valid date.`);
  }

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    iso: date.toISOString().slice(0, 10),
  };
}

export function calculateAgeOnDate(birthDate, referenceDate) {
  const birth = dateOnlyParts(birthDate, "Beneficiary birth date");
  const reference = dateOnlyParts(referenceDate, "Enrollment date");
  if (birth.iso > reference.iso) {
    invalidEligibilityData(
      "Beneficiary birth date cannot be later than the enrollment date.",
    );
  }

  const birthdayHasPassed = reference.month > birth.month
    || (reference.month === birth.month && reference.day >= birth.day);
  return reference.year - birth.year - (birthdayHasPassed ? 0 : 1);
}

function assertUniqueList(values, criterion) {
  if (new Set(values).size !== values.length) {
    invalidCriterion(criterion, "Eligibility criterion list values must be unique.");
  }
}

function assertAgeExpectedValue(criterion) {
  const { expectedValue, operator } = criterion;
  const values = LIST_OPERATORS.has(operator) ? expectedValue : [expectedValue];
  if ((LIST_OPERATORS.has(operator) && (!Array.isArray(values) || values.length === 0))
    || values.length > 20
    || values.some((value) => !Number.isInteger(value) || value < 0 || value > 150)) {
    invalidCriterion(
      criterion,
      LIST_OPERATORS.has(operator)
        ? "AGE IN and NOT_IN criteria require 1 to 20 integer ages from 0 to 150."
        : "AGE criteria require an integer age from 0 to 150.",
    );
  }
  if (LIST_OPERATORS.has(operator)) {
    assertUniqueList(values, criterion);
  }
}

function assertSetExpectedValue(criterion, allowedValues, valueLabel) {
  const { expectedValue, operator } = criterion;
  const values = LIST_OPERATORS.has(operator) ? expectedValue : [expectedValue];
  if ((LIST_OPERATORS.has(operator) && (!Array.isArray(values) || values.length === 0))
    || values.length > allowedValues.size
    || values.some((value) => typeof value !== "string" || !allowedValues.has(value))) {
    invalidCriterion(
      criterion,
      `${valueLabel} criterion has an invalid expected value.`,
    );
  }
  if (LIST_OPERATORS.has(operator)) {
    assertUniqueList(values, criterion);
  }
}

function assertUuidExpectedValue(criterion) {
  const { expectedValue, operator } = criterion;
  const values = LIST_OPERATORS.has(operator) ? expectedValue : [expectedValue];
  if ((LIST_OPERATORS.has(operator) && (!Array.isArray(values) || values.length === 0))
    || values.length > 50
    || values.some((value) => typeof value !== "string" || !UUID_PATTERN.test(value))) {
    invalidCriterion(criterion, "BARANGAY_ID criterion requires a valid UUID or UUID list.");
  }
  if (LIST_OPERATORS.has(operator)) {
    assertUniqueList(values, criterion);
  }
}

function assertCriterionDefinition(criterion) {
  if (!criterion || typeof criterion !== "object") {
    invalidCriterion(criterion, "Eligibility criterion is invalid.");
  }

  switch (criterion.fieldName) {
    case "AGE":
      if (!AGE_OPERATORS.has(criterion.operator)) {
        invalidCriterion(criterion, `AGE does not support ${criterion.operator}.`);
      }
      assertAgeExpectedValue(criterion);
      break;
    case "SEX":
      if (!VALUE_OPERATORS.has(criterion.operator)) {
        invalidCriterion(criterion, `SEX does not support ${criterion.operator}.`);
      }
      assertSetExpectedValue(criterion, SEX_VALUES, "SEX");
      break;
    case "BARANGAY_ID":
      if (!VALUE_OPERATORS.has(criterion.operator)) {
        invalidCriterion(criterion, `BARANGAY_ID does not support ${criterion.operator}.`);
      }
      assertUuidExpectedValue(criterion);
      break;
    case "DOCUMENT_TYPE":
      if (criterion.operator !== "REQUIRED" || !DOCUMENT_TYPES.has(criterion.expectedValue)) {
        invalidCriterion(
          criterion,
          "DOCUMENT_TYPE requires one supported document type with the REQUIRED operator.",
        );
      }
      break;
    case "MANUAL_REVIEW":
      if (criterion.operator !== "REQUIRED" || criterion.expectedValue !== true) {
        invalidCriterion(
          criterion,
          "MANUAL_REVIEW requires the REQUIRED operator and an expected value of true.",
        );
      }
      break;
    default:
      invalidCriterion(criterion, `Unsupported eligibility field ${criterion.fieldName}.`);
  }
}

function compare(actualValue, operator, expectedValue) {
  switch (operator) {
    case "EQUALS":
      return actualValue === expectedValue;
    case "NOT_EQUALS":
      return actualValue !== expectedValue;
    case "GREATER_THAN":
      return actualValue > expectedValue;
    case "GREATER_THAN_OR_EQUAL":
      return actualValue >= expectedValue;
    case "LESS_THAN":
      return actualValue < expectedValue;
    case "LESS_THAN_OR_EQUAL":
      return actualValue <= expectedValue;
    case "IN":
      return expectedValue.includes(actualValue);
    case "NOT_IN":
      return !expectedValue.includes(actualValue);
    default:
      return false;
  }
}

function normalizeManualDecisions(criteria, manualDecisions) {
  if (!Array.isArray(manualDecisions)) {
    throw new AppError(
      400,
      "INVALID_MANUAL_ELIGIBILITY_DECISION",
      "Manual eligibility decisions must be supplied as a list.",
    );
  }

  const criteriaById = new Map(criteria.map((criterion) => [criterion.criterionId, criterion]));
  const decisionsById = new Map();
  for (const decision of manualDecisions) {
    const criterion = criteriaById.get(decision?.criterionId);
    const remarks = typeof decision?.remarks === "string" ? decision.remarks.trim() : "";
    if (!criterion || criterion.fieldName !== "MANUAL_REVIEW") {
      throw new AppError(
        400,
        "INVALID_MANUAL_ELIGIBILITY_DECISION",
        "A manual decision must reference a MANUAL_REVIEW criterion in this program.",
        { criterionId: decision?.criterionId ?? null },
      );
    }
    if (decisionsById.has(decision.criterionId)) {
      throw new AppError(
        400,
        "DUPLICATE_MANUAL_ELIGIBILITY_DECISION",
        "Each manual eligibility criterion may be decided only once.",
        { criterionId: decision.criterionId },
      );
    }
    if (typeof decision.passed !== "boolean" || remarks.length < 5 || remarks.length > 1000) {
      throw new AppError(
        400,
        "INVALID_MANUAL_ELIGIBILITY_DECISION",
        "Each manual decision requires a boolean result and remarks from 5 to 1000 characters.",
        { criterionId: decision.criterionId },
      );
    }

    decisionsById.set(decision.criterionId, { passed: decision.passed, remarks });
  }
  return decisionsById;
}

function resultFor(criterion, actualValue, outcome, reason, { forceBlocking = false } = {}) {
  return {
    criterionId: criterion.criterionId,
    criterionName: criterion.criterionName,
    fieldName: criterion.fieldName,
    operator: criterion.operator,
    expectedValue: Array.isArray(criterion.expectedValue)
      ? [...criterion.expectedValue]
      : criterion.expectedValue,
    actualValue,
    isRequired: criterion.isRequired !== false,
    outcome,
    blocking: forceBlocking
      || (criterion.isRequired !== false && outcome === ELIGIBILITY_OUTCOMES.NOT_MET),
    reason,
  };
}

export function evaluateEnrollmentEligibility(enrollment, { manualDecisions = [] } = {}) {
  if (!enrollment?.program || !enrollment?.beneficiary || !enrollment?.enrollmentDate) {
    invalidEligibilityData(
      "Enrollment eligibility requires the program, beneficiary, and enrollment date.",
    );
  }

  const criteria = enrollment.program.criteria ?? [];
  if (!Array.isArray(criteria) || criteria.length === 0) {
    invalidEligibilityData("The assistance program has no eligibility criteria.");
  }
  for (const criterion of criteria) {
    assertCriterionDefinition(criterion);
  }

  const decisionsById = normalizeManualDecisions(criteria, manualDecisions);
  const referenceDate = dateOnlyParts(enrollment.enrollmentDate, "Enrollment date").iso;
  const acceptedDocumentTypes = new Set(
    (enrollment.beneficiary.documents ?? [])
      .filter((document) => document.reviewStatus === "ACCEPTED")
      .map((document) => document.documentType),
  );
  let age;

  const results = criteria.map((criterion) => {
    if (criterion.fieldName === "MANUAL_REVIEW") {
      const decision = decisionsById.get(criterion.criterionId);
      if (!decision) {
        return resultFor(
          criterion,
          null,
          ELIGIBILITY_OUTCOMES.REVIEW_REQUIRED,
          "A DSWD reviewer must record this manual decision.",
          { forceBlocking: true },
        );
      }
      return resultFor(
        criterion,
        decision,
        decision.passed ? ELIGIBILITY_OUTCOMES.MET : ELIGIBILITY_OUTCOMES.NOT_MET,
        decision.passed ? "Manual criterion met." : "Manual criterion not met.",
      );
    }

    let actualValue;
    let passed;
    switch (criterion.fieldName) {
      case "AGE":
        age ??= calculateAgeOnDate(enrollment.beneficiary.birthDate, enrollment.enrollmentDate);
        actualValue = age;
        passed = compare(actualValue, criterion.operator, criterion.expectedValue);
        break;
      case "SEX":
        actualValue = enrollment.beneficiary.sex;
        passed = compare(actualValue, criterion.operator, criterion.expectedValue);
        break;
      case "BARANGAY_ID":
        actualValue = enrollment.beneficiary.barangayId;
        passed = compare(actualValue, criterion.operator, criterion.expectedValue);
        break;
      case "DOCUMENT_TYPE":
        passed = acceptedDocumentTypes.has(criterion.expectedValue);
        actualValue = { documentType: criterion.expectedValue, accepted: passed };
        break;
      default:
        return null;
    }

    return resultFor(
      criterion,
      actualValue,
      passed ? ELIGIBILITY_OUTCOMES.MET : ELIGIBILITY_OUTCOMES.NOT_MET,
      passed ? "Criterion met." : "Criterion not met.",
    );
  });

  const hasRequiredFailure = results.some((result) => result.blocking
    && result.outcome === ELIGIBILITY_OUTCOMES.NOT_MET);
  const needsManualReview = results.some(
    (result) => result.outcome === ELIGIBILITY_OUTCOMES.REVIEW_REQUIRED,
  );
  const overallStatus = hasRequiredFailure
    ? ELIGIBILITY_STATUSES.INELIGIBLE
    : needsManualReview
      ? ELIGIBILITY_STATUSES.REVIEW_REQUIRED
      : ELIGIBILITY_STATUSES.ELIGIBLE;

  return {
    overallStatus,
    referenceDate,
    summary: {
      total: results.length,
      met: results.filter((result) => result.outcome === ELIGIBILITY_OUTCOMES.MET).length,
      notMet: results.filter((result) => result.outcome === ELIGIBILITY_OUTCOMES.NOT_MET).length,
      reviewRequired: results.filter(
        (result) => result.outcome === ELIGIBILITY_OUTCOMES.REVIEW_REQUIRED,
      ).length,
      blocking: results.filter((result) => result.blocking).length,
    },
    results,
  };
}
