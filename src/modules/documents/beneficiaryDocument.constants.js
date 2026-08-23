export const BENEFICIARY_DOCUMENT_TYPES = Object.freeze([
  "VALID_ID",
  "BIRTH_CERTIFICATE",
  "BARANGAY_CERTIFICATE",
  "PROOF_OF_RESIDENCY",
  "MEDICAL_CERTIFICATE",
  "PWD_ID",
  "SENIOR_CITIZEN_ID",
  "OTHER",
]);

export const BENEFICIARY_DOCUMENT_MIME_TYPES = Object.freeze([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

export const BENEFICIARY_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
