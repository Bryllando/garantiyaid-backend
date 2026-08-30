import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_DISPUTE_REASONS,
  claimDisputeListQuerySchema,
  createClaimDisputeSchema,
  reviewClaimDisputeSchema,
} from "../src/modules/distributions/distributionClaimAccountability.schemas.js";
import {
  assertClaimReceiptAvailable,
  assertDisputeCanBeFiled,
  buildClaimReceiptSnapshot,
  claimReceiptEvidenceHash,
  disputeReviewUpdate,
  generateClaimReceiptNo,
  generateDisputeReference,
} from "../src/modules/distributions/distributionClaimAccountability.service.js";
import {
  CLAIM_DISPUTE_FILE_ROLES,
  CLAIM_DISPUTE_REVIEW_ROLES,
  assertClaimDisputeReviewAllowed,
} from "../src/modules/distributions/distribution.policy.js";

const filerId = "11111111-1111-4111-8111-111111111111";
const reviewerId = "22222222-2222-4222-8222-222222222222";

function receiptClaim(overrides = {}) {
  return {
    claimId: filerId,
    claimStatus: "CLAIMED",
    verificationMethod: "BIOMETRIC_AND_SIGNATURE",
    biometricVerified: true,
    qrVerified: false,
    signatureVerified: true,
    claimedAt: new Date("2026-08-30T02:30:00.000Z"),
    updatedAt: new Date("2026-08-30T02:25:00.000Z"),
    beneficiary: {
      beneficiaryId: reviewerId,
      firstName: "Maria",
      middleName: "Santos",
      lastName: "Cruz",
      sitioPurok: "Sitio Uno",
      barangay: { barangayName: "Liburon" },
    },
    distribution: {
      distributionId: reviewerId,
      title: "Food Assistance",
      distributionDate: new Date("2026-08-30T00:00:00.000Z"),
      location: "Barangay Hall",
      program: { programCode: "AICS", programName: "Assistance" },
      barangay: { barangayName: "Liburon" },
    },
    schedule: {
      queueNumber: 21,
      status: "CHECKED_IN",
      slot: {
        sessionLabel: "Morning",
        location: "Barangay Hall",
        slotStart: new Date("2026-08-30T00:00:00.000Z"),
        slotEnd: new Date("2026-08-30T01:00:00.000Z"),
      },
    },
    allocation: { amount: { toString: () => "3000.00" }, allocationStatus: "CLAIMED" },
    verifiedBy: { userId: reviewerId, employeeId: "DSWD-01", fullName: "Ana Reviewer", role: "DSWD_STAFF" },
    signature: {
      imageSha256: "a".repeat(64),
      signatureMethod: "DRAWN",
      pointCount: 94,
      signedAt: new Date("2026-08-30T02:25:00.000Z"),
      capturedBy: { userId: reviewerId, employeeId: "DSWD-01", fullName: "Ana Reviewer", role: "DSWD_STAFF" },
    },
    biometricAttempts: [{
      result: "MATCHED",
      matchScore: { toString: () => "0.9400" },
      livenessScore: { toString: () => "0.9700" },
      processor: "INSIGHTFACE",
      createdAt: new Date("2026-08-30T02:24:00.000Z"),
      verifiedBy: { userId: reviewerId, employeeId: "DSWD-01", fullName: "Ana Reviewer", role: "DSWD_STAFF" },
    }],
    transactions: [{
      referenceNo: "GYA-SIM-CREDIT-20260830-ABCDEF1234567890",
      status: "COMPLETED",
      createdAt: new Date("2026-08-30T02:30:00.000Z"),
      initiatedBy: { userId: reviewerId, employeeId: "DSWD-01", fullName: "Ana Reviewer", role: "DSWD_STAFF" },
    }],
    ...overrides,
  };
}

function dispute(overrides = {}) {
  return {
    status: "OPEN",
    filedBy: { userId: filerId },
    assignedTo: null,
    claim: { claimStatus: "CLAIMED" },
    ...overrides,
  };
}

test("claim accountability schemas normalize inputs and require attestation and review evidence", () => {
  assert.equal(CLAIM_DISPUTE_REASONS.includes("BENEFICIARY_DENIES_RECEIPT"), true);
  assert.deepEqual(createClaimDisputeSchema.parse({
    reasonCode: " beneficiary_denies_receipt ",
    statement: " Beneficiary personally denies receiving this assistance. ",
    beneficiaryPresent: true,
  }), {
    reasonCode: "BENEFICIARY_DENIES_RECEIPT",
    statement: "Beneficiary personally denies receiving this assistance.",
    beneficiaryPresent: true,
  });
  assert.equal(createClaimDisputeSchema.safeParse({
    reasonCode: "OTHER",
    statement: "Too short",
    beneficiaryPresent: false,
  }).success, false);
  assert.equal(reviewClaimDisputeSchema.safeParse({ action: "CONFIRM_CLAIM" }).success, false);
  assert.deepEqual(claimDisputeListQuerySchema.parse({}), { page: 1, pageSize: 20 });
});

test("receipt is immutable evidence metadata without raw face or signature images", () => {
  const claim = receiptClaim();
  assert.doesNotThrow(() => assertClaimReceiptAvailable(claim));
  assert.throws(
    () => assertClaimReceiptAvailable(receiptClaim({ claimStatus: "VERIFIED" })),
    (error) => error.code === "CLAIM_RECEIPT_NOT_AVAILABLE",
  );
  const snapshot = buildClaimReceiptSnapshot(claim);
  assert.equal(snapshot.beneficiary.fullName, "Maria Santos Cruz");
  assert.equal(snapshot.assistance.amount, "3000.00");
  assert.equal(snapshot.verificationEvidence.signature.imageSha256, "a".repeat(64));
  assert.equal(Object.hasOwn(snapshot.verificationEvidence.signature, "encryptedImage"), false);
  assert.equal(Object.hasOwn(snapshot.verificationEvidence.biometric, "faceImage"), false);
  assert.match(claimReceiptEvidenceHash(snapshot), /^[a-f0-9]{64}$/);
  assert.notEqual(
    claimReceiptEvidenceHash(snapshot),
    claimReceiptEvidenceHash({ ...snapshot, assistance: { ...snapshot.assistance, amount: "3001.00" } }),
  );
  assert.match(generateClaimReceiptNo(new Date("2026-08-30T00:00:00.000Z")), /^GYA-CLM-20260830-[A-F0-9]{12}$/);
  assert.match(generateDisputeReference(new Date("2026-08-30T00:00:00.000Z")), /^GYA-DSP-20260830-[A-F0-9]{12}$/);
});

test("disputes enforce role separation and reversal-first remediation", () => {
  assert.deepEqual(CLAIM_DISPUTE_FILE_ROLES, ["SYSTEM_ADMIN", "DSWD_STAFF", "BARANGAY_FACILITATOR"]);
  assert.deepEqual(CLAIM_DISPUTE_REVIEW_ROLES, ["SYSTEM_ADMIN", "DSWD_STAFF"]);
  assert.doesNotThrow(() => assertClaimDisputeReviewAllowed({ role: "DSWD_STAFF" }));
  assert.throws(
    () => assertClaimDisputeReviewAllowed({ role: "BARANGAY_FACILITATOR" }),
    (error) => error.code === "FORBIDDEN",
  );
  assert.doesNotThrow(() => assertDisputeCanBeFiled({ claimStatus: "CLAIMED" }, 0));
  assert.throws(
    () => assertDisputeCanBeFiled({ claimStatus: "CLAIMED" }, 1),
    (error) => error.code === "ACTIVE_CLAIM_DISPUTE_EXISTS",
  );
  assert.throws(
    () => disputeReviewUpdate(dispute(), "START_REVIEW", filerId),
    (error) => error.code === "INDEPENDENT_REVIEW_REQUIRED",
  );
  const started = disputeReviewUpdate(dispute(), "START_REVIEW", reviewerId);
  assert.equal(started.disputeData.status, "UNDER_REVIEW");
  assert.throws(
    () => disputeReviewUpdate(dispute({
      status: "UNDER_REVIEW",
      assignedTo: { userId: reviewerId },
    }), "COMPLETE_REMEDIATION", reviewerId, "Verified discrepancy and corrective steps."),
    (error) => error.code === "CLAIM_REVERSAL_REQUIRED",
  );
  const remediated = disputeReviewUpdate(dispute({
    status: "UNDER_REVIEW",
    assignedTo: { userId: reviewerId },
    claim: { claimStatus: "VOIDED" },
  }), "COMPLETE_REMEDIATION", reviewerId, "Credit reversed and beneficiary informed.");
  assert.equal(remediated.disputeData.outcome, "BENEFICIARY_REMEDIATION");
});
