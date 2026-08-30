import test from "node:test";
import assert from "node:assert/strict";
import walletRoutes from "../src/modules/wallets/wallet.routes.js";
import {
  SIMULATED_TRANSACTION_TYPES,
  TRANSACTION_STATUSES,
  createWalletSchema,
  creditClaimSchema,
  reverseBenefitCreditSchema,
  simulatedTransferSchema,
  walletTransactionListQuerySchema,
} from "../src/modules/wallets/wallet.schemas.js";
import {
  SIMULATION_DISCLOSURE,
  assertClaimCreditable,
  assertWalletActive,
  generateTransactionReference,
  transactionPublicSelect,
  transactionRequestHash,
  transactionSignedAmount,
  transactionToResponse,
  walletPublicSelect,
  walletToResponse,
} from "../src/modules/wallets/wallet.service.js";
import {
  WALLET_MANAGE_ROLES,
  WALLET_READ_ROLES,
  assertWalletManageAllowed,
  assertWalletReadAllowed,
} from "../src/modules/distributions/distribution.policy.js";

const beneficiaryId = "11111111-1111-4111-8111-111111111111";
const recipientBeneficiaryId = "22222222-2222-4222-8222-222222222222";

function creditableClaim(overrides = {}) {
  return {
    claimStatus: "VERIFIED",
    qrVerified: true,
    biometricVerified: false,
    allocation: { allocationStatus: "ALLOCATED" },
    schedule: { status: "CHECKED_IN" },
    beneficiary: { status: "ACTIVE" },
    disputes: [],
    ...overrides,
  };
}

test("Phase 6 schemas validate wallet creation, monetary precision, filters, and reversal reasons", () => {
  assert.deepEqual(createWalletSchema.parse({ beneficiaryId }), { beneficiaryId });
  assert.deepEqual(creditClaimSchema.parse({ description: "  Phase 6 credit  " }), {
    description: "Phase 6 credit",
  });
  assert.deepEqual(simulatedTransferSchema.parse({
    recipientBeneficiaryId,
    amount: "125.50",
  }), { recipientBeneficiaryId, amount: 125.5 });
  assert.equal(simulatedTransferSchema.safeParse({
    recipientBeneficiaryId,
    amount: 0,
  }).success, false);
  assert.equal(simulatedTransferSchema.safeParse({
    recipientBeneficiaryId,
    amount: 1.001,
  }).success, false);
  assert.equal(reverseBenefitCreditSchema.safeParse({ reason: "bad" }).success, false);
  assert.deepEqual(walletTransactionListQuerySchema.parse({ type: " benefit_credit " }), {
    page: 1,
    pageSize: 20,
    type: "BENEFIT_CREDIT",
  });
  assert.deepEqual(SIMULATED_TRANSACTION_TYPES, [
    "BENEFIT_CREDIT",
    "SIMULATED_TRANSFER_OUT",
    "SIMULATED_TRANSFER_IN",
    "BENEFIT_REVERSAL",
  ]);
  assert.deepEqual(TRANSACTION_STATUSES, ["PENDING", "COMPLETED", "FAILED", "REVERSED"]);
});

test("wallet access excludes Barangay Facilitators from financial ledger data", () => {
  assert.deepEqual(WALLET_READ_ROLES, ["SYSTEM_ADMIN", "DSWD_STAFF"]);
  assert.deepEqual(WALLET_MANAGE_ROLES, ["SYSTEM_ADMIN", "DSWD_STAFF"]);
  assert.doesNotThrow(() => assertWalletReadAllowed({ role: "DSWD_STAFF" }));
  assert.doesNotThrow(() => assertWalletManageAllowed({ role: "SYSTEM_ADMIN" }));
  assert.throws(
    () => assertWalletReadAllowed({ role: "BARANGAY_FACILITATOR" }),
    (error) => error.code === "FORBIDDEN",
  );
  assert.throws(
    () => assertWalletManageAllowed({ role: "BARANGAY_FACILITATOR" }),
    (error) => error.code === "FORBIDDEN",
  );
});

test("credit eligibility requires a verified claim, checked-in schedule, active allocation and beneficiary", () => {
  assert.doesNotThrow(() => assertClaimCreditable(creditableClaim()));
  assert.doesNotThrow(() => assertClaimCreditable(creditableClaim({
    qrVerified: false,
    biometricVerified: true,
  })));
  assert.doesNotThrow(() => assertClaimCreditable(creditableClaim({
    verificationMethod: "BIOMETRIC_AND_SIGNATURE",
    qrVerified: false,
    biometricVerified: true,
    signatureVerified: true,
  })));
  assert.throws(
    () => assertClaimCreditable(creditableClaim({
      verificationMethod: "BIOMETRIC_AND_SIGNATURE",
      qrVerified: false,
      biometricVerified: true,
      signatureVerified: false,
    })),
    (error) => error.code === "CLAIM_IDENTITY_NOT_VERIFIED",
  );
  assert.throws(
    () => assertClaimCreditable(creditableClaim({
      disputes: [{ disputeId: beneficiaryId, status: "UNDER_REVIEW" }],
    })),
    (error) => error.code === "ACTIVE_CLAIM_DISPUTE",
  );
  assert.throws(
    () => assertClaimCreditable(creditableClaim({ claimStatus: "CLAIMED" })),
    (error) => error.code === "CLAIM_NOT_CREDITABLE",
  );
  assert.throws(
    () => assertClaimCreditable(creditableClaim({ qrVerified: false })),
    (error) => error.code === "CLAIM_IDENTITY_NOT_VERIFIED",
  );
  assert.throws(
    () => assertClaimCreditable(creditableClaim({
      allocation: { allocationStatus: "CANCELLED" },
    })),
    (error) => error.code === "ALLOCATION_NOT_CREDITABLE",
  );
  assert.throws(
    () => assertClaimCreditable(creditableClaim({ schedule: { status: "SCHEDULED" } })),
    (error) => error.code === "SCHEDULE_NOT_CHECKED_IN",
  );
  assert.throws(
    () => assertClaimCreditable(creditableClaim({ beneficiary: { status: "INACTIVE" } })),
    (error) => error.code === "BENEFICIARY_NOT_ACTIVE",
  );
  assert.doesNotThrow(() => assertWalletActive({ accountStatus: "ACTIVE" }));
  assert.throws(
    () => assertWalletActive({ accountStatus: "SUSPENDED" }),
    (error) => error.code === "SIMULATED_WALLET_NOT_ACTIVE",
  );
});

test("transaction hashes, references, directions, and simulation disclosure are deterministic and explicit", () => {
  const request = { walletId: beneficiaryId, amount: "100.00" };
  assert.equal(transactionRequestHash(request), transactionRequestHash(request));
  assert.notEqual(
    transactionRequestHash(request),
    transactionRequestHash({ ...request, amount: "101.00" }),
  );
  assert.match(generateTransactionReference("CREDIT"), /^GYA-SIM-CREDIT-\d{8}-[A-F0-9]{16}$/);
  assert.equal(transactionSignedAmount({ transactionType: "BENEFIT_CREDIT", amount: 100 }), 100);
  assert.equal(transactionSignedAmount({ transactionType: "SIMULATED_TRANSFER_OUT", amount: 100 }), -100);
  assert.equal(transactionSignedAmount({ transactionType: "BENEFIT_REVERSAL", amount: 100 }), -100);
  assert.equal(SIMULATION_DISCLOSURE.simulated, true);
  assert.equal(SIMULATION_DISCLOSURE.realFundsMoved, false);
  assert.equal(SIMULATION_DISCLOSURE.externalPaymentRailConnected, false);
});

test("public wallet and transaction responses preserve ledger fields without credentials or bank data", () => {
  assert.equal(Object.hasOwn(walletPublicSelect.beneficiary.select, "passwordHash"), false);
  assert.equal(Object.hasOwn(walletPublicSelect.beneficiary.select, "contactNumber"), false);
  assert.equal(Object.hasOwn(transactionPublicSelect.initiatedBy.select, "passwordHash"), false);
  assert.equal(Object.hasOwn(transactionPublicSelect, "bankAccountNumber"), false);
  assert.equal(Object.hasOwn(transactionPublicSelect, "externalPaymentToken"), false);

  const wallet = walletToResponse({ walletId: beneficiaryId, balance: { toString: () => "5000.00" } });
  assert.equal(wallet.balance, "5000.00");
  const transaction = transactionToResponse({
    transactionId: beneficiaryId,
    amount: { toString: () => "5000.00" },
    balanceBefore: { toString: () => "0.00" },
    balanceAfter: { toString: () => "5000.00" },
    reversalOf: null,
    reversal: null,
  });
  assert.equal(transaction.amount, "5000.00");
  assert.equal(transaction.balanceBefore, "0.00");
  assert.equal(transaction.balanceAfter, "5000.00");
});

test("wallet router exposes create, read, transfer, receipt, and reversal endpoints", () => {
  const routes = walletRoutes.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).sort(),
    }));
  assert.deepEqual(routes, [
    { path: "/", methods: ["post"] },
    { path: "/:walletId", methods: ["get"] },
    { path: "/:walletId/transactions", methods: ["get"] },
    { path: "/:walletId/transfers", methods: ["post"] },
    { path: "/:walletId/transactions/:transactionId/receipt", methods: ["get"] },
    { path: "/:walletId/transactions/:transactionId/reverse", methods: ["post"] },
  ]);
});
