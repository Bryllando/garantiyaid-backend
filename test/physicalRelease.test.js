import test from "node:test";
import assert from "node:assert/strict";
import {
  markPhysicalClaimReleasedSchema,
  PHYSICAL_RELEASE_EVIDENCE_TYPES,
} from "../src/modules/distributions/distributionClaim.schemas.js";
import {
  PHYSICAL_RELEASE_ROLES,
  assertPhysicalReleaseAllowed,
} from "../src/modules/distributions/distribution.policy.js";
import {
  assertPhysicalClaimReleasable,
} from "../src/modules/distributions/distributionClaim.service.js";
import {
  buildClaimReceiptSnapshot,
  disputeReviewUpdate,
} from "../src/modules/distributions/distributionClaimAccountability.service.js";
import { claimReconciliationException } from "../src/modules/wallets/wallet.service.js";

const facilitatorId = "11111111-1111-4111-8111-111111111111";
const reviewerId = "22222222-2222-4222-8222-222222222222";

function releasableClaim(overrides = {}) {
  return {
    claimId: "33333333-3333-4333-8333-333333333333",
    claimStatus: "VERIFIED",
    verificationMethod: "QR_AND_BIOMETRIC",
    qrVerified: true,
    biometricVerified: true,
    signatureVerified: false,
    releaseMethod: null,
    releasedAt: null,
    allocation: { allocationStatus: "ALLOCATED" },
    schedule: { status: "CHECKED_IN" },
    beneficiary: { status: "ACTIVE" },
    disputes: [],
    transactions: [],
    ...overrides,
  };
}

const physicalDistribution = { status: "OPEN", deliveryMode: "PHYSICAL_GOODS" };

test("physical release input is controlled, explicit, and acknowledged", () => {
  assert.deepEqual(PHYSICAL_RELEASE_EVIDENCE_TYPES, [
    "SIGNED_ACKNOWLEDGEMENT",
    "OFFICIAL_RELEASE_LOG",
    "PHOTO_REFERENCE",
    "OTHER",
  ]);
  assert.deepEqual(markPhysicalClaimReleasedSchema.parse({
    evidenceType: " official_release_log ",
    evidenceReference: "  Logbook 12 / Row 4  ",
    notes: "  Two food packs released.  ",
    beneficiaryAcknowledged: true,
  }), {
    evidenceType: "OFFICIAL_RELEASE_LOG",
    evidenceReference: "Logbook 12 / Row 4",
    notes: "Two food packs released.",
    beneficiaryAcknowledged: true,
  });
  assert.equal(markPhysicalClaimReleasedSchema.safeParse({
    evidenceType: "OFFICIAL_RELEASE_LOG",
    evidenceReference: "x",
    beneficiaryAcknowledged: false,
  }).success, false);
});

test("only the assigned facilitator role can use physical release", () => {
  assert.deepEqual(PHYSICAL_RELEASE_ROLES, ["BARANGAY_FACILITATOR"]);
  assert.doesNotThrow(() => assertPhysicalReleaseAllowed({ role: "BARANGAY_FACILITATOR" }));
  assert.throws(
    () => assertPhysicalReleaseAllowed({ role: "SYSTEM_ADMIN" }),
    (error) => error.code === "FORBIDDEN",
  );
});

test("physical release requires the configured verification and unsettled lifecycle", () => {
  assert.doesNotThrow(() => assertPhysicalClaimReleasable(
    releasableClaim(),
    physicalDistribution,
  ));
  assert.throws(
    () => assertPhysicalClaimReleasable(
      releasableClaim({ biometricVerified: false }),
      physicalDistribution,
    ),
    (error) => error.code === "CLAIM_IDENTITY_NOT_VERIFIED",
  );
  assert.throws(
    () => assertPhysicalClaimReleasable(
      releasableClaim({ claimStatus: "CLAIMED", releaseMethod: "PHYSICAL_GOODS" }),
      physicalDistribution,
    ),
    (error) => error.code === "CLAIM_NOT_RELEASABLE",
  );
  assert.throws(
    () => assertPhysicalClaimReleasable(
      releasableClaim(),
      { ...physicalDistribution, deliveryMode: "SIMULATED_WALLET" },
    ),
    (error) => error.code === "DISTRIBUTION_NOT_PHYSICAL_GOODS",
  );
});

test("physical claims reconcile without wallet credits or reversals", () => {
  assert.equal(claimReconciliationException(releasableClaim({
    claimStatus: "CLAIMED",
    releaseMethod: "PHYSICAL_GOODS",
    releasedAt: new Date(),
    releasedById: facilitatorId,
  }), "PHYSICAL_GOODS"), null);
  assert.equal(
    claimReconciliationException(releasableClaim(), "PHYSICAL_GOODS").code,
    "VERIFIED_PHYSICAL_CLAIM_AWAITING_RELEASE",
  );
  assert.equal(claimReconciliationException(releasableClaim({
    claimStatus: "VOIDED",
    releaseMethod: "PHYSICAL_GOODS",
  }), "PHYSICAL_GOODS"), null);
  assert.equal(
    claimReconciliationException(releasableClaim({
      claimStatus: "CLAIMED",
      releaseMethod: "SIMULATED_WALLET",
    }), "SIMULATED_WALLET").code,
    "CLAIMED_WITHOUT_COMPLETED_CREDIT",
  );
});

test("a physical release can be remediated without a wallet reversal", () => {
  const change = disputeReviewUpdate({
    status: "UNDER_REVIEW",
    filedBy: { userId: facilitatorId },
    assignedTo: { userId: reviewerId },
    claim: {
      claimStatus: "CLAIMED",
      releaseMethod: "PHYSICAL_GOODS",
      distribution: { deliveryMode: "PHYSICAL_GOODS" },
    },
  }, "COMPLETE_REMEDIATION", reviewerId, "Physical release discrepancy documented and corrected.");
  assert.equal(change.claimExpectedStatus, "CLAIMED");
  assert.deepEqual(change.claimData, { claimStatus: "VOIDED" });
  assert.equal(change.disputeData.outcome, "BENEFICIARY_REMEDIATION");
});

test("physical receipt snapshot includes release method, actor, time, and evidence", () => {
  const releasedAt = new Date("2026-09-17T03:30:00.000Z");
  const staff = {
    userId: facilitatorId,
    employeeId: "BF-001",
    fullName: "Juan Facilitator",
    role: "BARANGAY_FACILITATOR",
  };
  const snapshot = buildClaimReceiptSnapshot({
    claimId: "33333333-3333-4333-8333-333333333333",
    claimStatus: "CLAIMED",
    verificationMethod: "QR",
    qrVerified: true,
    biometricVerified: false,
    signatureVerified: false,
    releaseMethod: "PHYSICAL_GOODS",
    releasedAt,
    releasedBy: staff,
    releaseEvidenceType: "OFFICIAL_RELEASE_LOG",
    releaseEvidenceReference: "LOG-12-ROW-4",
    releaseNotes: "Two food packs released.",
    claimedAt: releasedAt,
    updatedAt: releasedAt,
    beneficiary: {
      beneficiaryId: "44444444-4444-4444-8444-444444444444",
      firstName: "Maria",
      middleName: null,
      lastName: "Cruz",
      sitioPurok: "Purok 1",
      barangay: { barangayName: "Liburon" },
    },
    distribution: {
      distributionId: "55555555-5555-4555-8555-555555555555",
      title: "Food Assistance",
      distributionDate: new Date("2026-09-17T00:00:00.000Z"),
      location: "Barangay Hall",
      deliveryMode: "PHYSICAL_GOODS",
      program: { programCode: "FOOD", programName: "Food Assistance" },
      barangay: { barangayName: "Liburon" },
    },
    schedule: {
      queueNumber: 4,
      status: "CHECKED_IN",
      slot: {
        sessionLabel: "Morning",
        location: "Barangay Hall",
        slotStart: new Date("2026-09-17T00:00:00.000Z"),
        slotEnd: new Date("2026-09-17T01:00:00.000Z"),
      },
    },
    allocation: { amount: { toString: () => "1500.00" }, allocationStatus: "CLAIMED" },
    verifiedBy: staff,
    signature: null,
    biometricAttempts: [],
    transactions: [],
  });
  assert.equal(snapshot.assistance.deliveryMode, "PHYSICAL_GOODS");
  assert.equal(snapshot.assistance.releasedBy.employeeId, "BF-001");
  assert.equal(snapshot.assistance.releasedAt, releasedAt.toISOString());
  assert.equal(snapshot.assistance.evidence.reference, "LOG-12-ROW-4");
});
