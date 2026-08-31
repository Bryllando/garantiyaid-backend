import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_STATUSES,
  QR_SCAN_RESULTS,
  QR_TOKEN_STATUSES,
  claimListQuerySchema,
  generateQrTokensSchema,
  qrScanLogListQuerySchema,
  qrTokenListQuerySchema,
  verifyQrClaimSchema,
} from "../src/modules/distributions/distributionClaim.schemas.js";
import {
  assertDistributionOpenForClaims,
  assertQrTokenReissuable,
  assertQrTokenRevocable,
  buildClaimSearchWhere,
  buildQrSearchWhere,
  buildQrStatusWhere,
  claimBeneficiarySelect,
  claimPublicSelect,
  claimToResponse,
  distributionQrExpiry,
  effectiveQrStatus,
  generateRawQrToken,
  hashQrToken,
  qrClaimPreviewOutcome,
  qrScanLogPublicSelect,
  qrTokenPublicSelect,
  qrTokenToResponse,
} from "../src/modules/distributions/distributionClaim.service.js";
import {
  CLAIM_VERIFY_ROLES,
  QR_TOKEN_MANAGE_ROLES,
  assertClaimVerifyAllowed,
  assertQrTokenManageAllowed,
} from "../src/modules/distributions/distribution.policy.js";

const scheduleId = "11111111-1111-4111-8111-111111111111";
const secondScheduleId = "22222222-2222-4222-8222-222222222222";
const qrTokenId = "33333333-3333-4333-8333-333333333333";

test("Phase 5 schemas validate generation, QR scans, filters, and controlled statuses", () => {
  assert.deepEqual(generateQrTokensSchema.parse({}), {});
  assert.deepEqual(generateQrTokensSchema.parse({
    scheduleIds: [scheduleId, secondScheduleId],
  }), { scheduleIds: [scheduleId, secondScheduleId] });
  assert.equal(generateQrTokensSchema.safeParse({
    scheduleIds: [scheduleId, scheduleId],
  }).success, false);
  assert.deepEqual(verifyQrClaimSchema.parse({
    token: "  gya1_example-token  ",
    deviceInfo: "  Postman Desktop  ",
  }), { token: "gya1_example-token", deviceInfo: "Postman Desktop" });
  assert.equal(verifyQrClaimSchema.safeParse({ token: "" }).success, false);
  assert.deepEqual(qrTokenListQuerySchema.parse({ status: " active " }), {
    page: 1,
    pageSize: 20,
    status: "ACTIVE",
  });
  assert.deepEqual(claimListQuerySchema.parse({ status: " verified " }), {
    page: 1,
    pageSize: 20,
    status: "VERIFIED",
  });
  assert.deepEqual(qrScanLogListQuerySchema.parse({ result: " duplicate " }), {
    page: 1,
    pageSize: 20,
    result: "DUPLICATE",
  });
  assert.deepEqual(QR_TOKEN_STATUSES, ["ACTIVE", "USED", "EXPIRED", "REVOKED"]);
  assert.deepEqual(CLAIM_STATUSES, ["PENDING", "VERIFIED", "CLAIMED", "REJECTED", "VOIDED"]);
  assert.equal(QR_SCAN_RESULTS.every((result) => result.length <= 20), true);
});

test("raw QR tokens are high entropy and only deterministic hashes are stored", () => {
  const first = generateRawQrToken();
  const second = generateRawQrToken();
  assert.match(first, /^gya1_[A-Za-z0-9_-]{43}$/);
  assert.match(second, /^gya1_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(hashQrToken(first).length, 64);
  assert.equal(hashQrToken(first), hashQrToken(first));
  assert.notEqual(hashQrToken(first), hashQrToken(second));
});

test("QR expiry is derived from the Philippine distribution event end time", () => {
  const expiresAt = distributionQrExpiry({
    distributionDate: new Date("2099-08-20T00:00:00.000Z"),
    endTime: new Date("1970-01-01T09:00:00.000Z"),
  });
  assert.equal(expiresAt.toISOString(), "2099-08-20T01:00:00.000Z");
});

test("effective token status and lifecycle prevent use of expired, used, or active reissue tokens", () => {
  const now = new Date("2099-08-20T01:00:00.000Z");
  const future = new Date("2099-08-20T02:00:00.000Z");
  const past = new Date("2099-08-20T00:00:00.000Z");
  assert.equal(effectiveQrStatus({ qrStatus: "ACTIVE", expiresAt: future }, now), "ACTIVE");
  assert.equal(effectiveQrStatus({ qrStatus: "ACTIVE", expiresAt: past }, now), "EXPIRED");
  assert.equal(effectiveQrStatus({ qrStatus: "REVOKED", expiresAt: past }, now), "REVOKED");
  assert.doesNotThrow(() => assertQrTokenRevocable({ qrStatus: "ACTIVE", expiresAt: future }, now));
  assert.throws(
    () => assertQrTokenRevocable({ qrStatus: "USED", expiresAt: future }, now),
    (error) => error.code === "QR_TOKEN_NOT_REVOCABLE",
  );
  assert.doesNotThrow(() => assertQrTokenReissuable({ qrStatus: "REVOKED", expiresAt: future }, now));
  assert.doesNotThrow(() => assertQrTokenReissuable({ qrStatus: "ACTIVE", expiresAt: past }, now));
  assert.throws(
    () => assertQrTokenReissuable({ qrStatus: "ACTIVE", expiresAt: future }, now),
    (error) => error.code === "QR_TOKEN_NOT_REISSUABLE",
  );
});

test("QR preview blocks unusable credentials and describes the confirmation effect", () => {
  const base = {
    distribution: { verificationRequirement: "QR_AND_BIOMETRIC" },
    qrToken: { qrStatus: "ACTIVE", expiresAt: new Date("2099-08-20T02:00:00.000Z") },
    schedule: { status: "SCHEDULED" },
    allocation: { allocationStatus: "ALLOCATED" },
    existingClaim: null,
    now: new Date("2099-08-20T01:00:00.000Z"),
  };
  assert.deepEqual(qrClaimPreviewOutcome(base), {
    ok: true,
    checksInBeneficiary: true,
    verificationCompleteAfterConfirm: false,
    nextRequiredVerification: "BIOMETRIC",
  });
  assert.equal(qrClaimPreviewOutcome({ ...base, qrToken: { ...base.qrToken, qrStatus: "USED" } }).code, "QR_TOKEN_ALREADY_USED");
  assert.deepEqual(qrClaimPreviewOutcome({
    ...base,
    schedule: { status: "CHECKED_IN" },
    existingClaim: { claimStatus: "PENDING", biometricVerified: true, qrVerified: false },
  }), {
    ok: true,
    checksInBeneficiary: false,
    verificationCompleteAfterConfirm: true,
    nextRequiredVerification: null,
  });
});

test("claim verification requires an OPEN event", () => {
  assert.doesNotThrow(() => assertDistributionOpenForClaims({ status: "OPEN" }));
  assert.throws(
    () => assertDistributionOpenForClaims({ status: "DRAFT" }),
    (error) => error.code === "DISTRIBUTION_NOT_OPEN_FOR_CLAIMS",
  );
  assert.throws(
    () => assertDistributionOpenForClaims({ status: "CANCELLED" }),
    (error) => error.code === "DISTRIBUTION_NOT_OPEN_FOR_CLAIMS",
  );
});

test("System Admin manages tokens while Admin and assigned Facilitator verify claims", () => {
  assert.deepEqual(QR_TOKEN_MANAGE_ROLES, ["SYSTEM_ADMIN"]);
  assert.deepEqual(CLAIM_VERIFY_ROLES, ["SYSTEM_ADMIN", "BARANGAY_FACILITATOR"]);
  assert.doesNotThrow(() => assertQrTokenManageAllowed({ role: "SYSTEM_ADMIN" }));
  assert.throws(
    () => assertQrTokenManageAllowed({ role: "DSWD_STAFF" }),
    (error) => error.code === "FORBIDDEN",
  );
  assert.doesNotThrow(() => assertClaimVerifyAllowed({ role: "SYSTEM_ADMIN" }));
  assert.doesNotThrow(() => assertClaimVerifyAllowed({ role: "BARANGAY_FACILITATOR" }));
  assert.throws(
    () => assertClaimVerifyAllowed({ role: "DSWD_STAFF" }),
    (error) => error.code === "FORBIDDEN",
  );
});

test("status and search helpers support effective expiry, names, and UUID identifiers", () => {
  const now = new Date("2099-08-20T01:00:00.000Z");
  assert.deepEqual(buildQrStatusWhere("ACTIVE", now), {
    qrStatus: "ACTIVE",
    expiresAt: { gt: now },
  });
  assert.equal(buildQrStatusWhere("EXPIRED", now).OR.length, 2);
  assert.deepEqual(buildQrStatusWhere(), {});
  assert.equal(buildQrSearchWhere("Pedro").OR.length, 3);
  assert.equal(buildQrSearchWhere(qrTokenId).OR.length, 5);
  assert.equal(buildClaimSearchWhere("Pedro").OR.length, 3);
  assert.equal(buildClaimSearchWhere(qrTokenId).OR.length, 7);
});

test("public Phase 5 responses exclude raw hashes, contact data, credentials, and transactions", () => {
  assert.equal(Object.hasOwn(qrTokenPublicSelect, "tokenHash"), false);
  assert.equal(Object.hasOwn(qrScanLogPublicSelect, "submittedTokenHash"), false);
  assert.equal(Object.hasOwn(claimBeneficiarySelect, "address"), false);
  assert.equal(Object.hasOwn(claimBeneficiarySelect, "contactNumber"), false);
  assert.equal(Object.hasOwn(claimBeneficiarySelect, "email"), false);
  assert.equal(Object.hasOwn(claimBeneficiarySelect, "philsysNumber"), false);
  assert.equal(Object.hasOwn(claimPublicSelect, "transactions"), false);
  assert.equal(Object.hasOwn(claimPublicSelect.verifiedBy.select, "passwordHash"), false);

  const qrResponse = qrTokenToResponse({
    qrTokenId,
    qrStatus: "ACTIVE",
    expiresAt: new Date("2099-08-20T00:00:00.000Z"),
  }, new Date("2099-08-20T01:00:00.000Z"));
  assert.equal(qrResponse.qrStatus, "EXPIRED");

  const claimResponse = claimToResponse({
    claimId: qrTokenId,
    biometricScore: null,
    allocation: {
      allocationId: scheduleId,
      amount: { toString: () => "5000.00" },
      allocationStatus: "ALLOCATED",
    },
    schedule: {
      scheduleId,
      slot: {
        slotStart: new Date("2099-08-20T00:00:00.000Z"),
        slotEnd: new Date("2099-08-20T00:30:00.000Z"),
      },
    },
  });
  assert.equal(claimResponse.allocation.amount, "5000.00");
  assert.equal(claimResponse.schedule.slot.slotStart, "2099-08-20T08:00:00+08:00");
});
