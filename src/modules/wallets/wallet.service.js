import { createHash, randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";

export const SIMULATION_DISCLOSURE = Object.freeze({
  simulated: true,
  realFundsMoved: false,
  externalPaymentRailConnected: false,
  message: "Prototype ledger simulation only; this is not a bank, e-wallet, cash-out, or government fund release.",
});

const beneficiaryWalletSelect = {
  beneficiaryId: true,
  firstName: true,
  middleName: true,
  lastName: true,
  barangayId: true,
  status: true,
  barangay: {
    select: {
      barangayId: true,
      barangayCode: true,
      barangayName: true,
      city: true,
      province: true,
    },
  },
};

const staffTransactionSelect = {
  userId: true,
  employeeId: true,
  username: true,
  fullName: true,
  role: true,
};

const relatedTransactionSelect = {
  transactionId: true,
  referenceNo: true,
  transactionType: true,
  status: true,
  amount: true,
  createdAt: true,
};

export const walletPublicSelect = {
  walletId: true,
  beneficiaryId: true,
  balance: true,
  currency: true,
  accountStatus: true,
  lastTransactionAt: true,
  createdAt: true,
  updatedAt: true,
  beneficiary: { select: beneficiaryWalletSelect },
};

export const walletMutationSelect = {
  walletId: true,
  beneficiaryId: true,
  balance: true,
  currency: true,
  accountStatus: true,
  lastTransactionAt: true,
  createdAt: true,
  updatedAt: true,
};

export const transactionPublicSelect = {
  transactionId: true,
  claimId: true,
  distributionId: true,
  walletId: true,
  beneficiaryId: true,
  initiatedById: true,
  amount: true,
  transactionType: true,
  referenceNo: true,
  status: true,
  balanceBefore: true,
  balanceAfter: true,
  transferGroupId: true,
  reversalOfId: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  beneficiary: { select: beneficiaryWalletSelect },
  initiatedBy: { select: staffTransactionSelect },
  reversalOf: { select: relatedTransactionSelect },
  reversal: { select: relatedTransactionSelect },
};

export const transactionMutationSelect = {
  transactionId: true,
  claimId: true,
  distributionId: true,
  walletId: true,
  beneficiaryId: true,
  initiatedById: true,
  amount: true,
  transactionType: true,
  referenceNo: true,
  status: true,
  balanceBefore: true,
  balanceAfter: true,
  transferGroupId: true,
  reversalOfId: true,
  description: true,
  createdAt: true,
  updatedAt: true,
};

export const receiptTransactionSelect = {
  ...transactionPublicSelect,
  claim: {
    select: {
      claimId: true,
      claimStatus: true,
      verificationMethod: true,
      qrVerified: true,
      biometricVerified: true,
      signatureVerified: true,
      claimedAt: true,
      allocation: {
        select: {
          allocationId: true,
          amount: true,
          allocationStatus: true,
        },
      },
    },
  },
  distribution: {
    select: {
      distributionId: true,
      title: true,
      distributionDate: true,
      location: true,
      status: true,
      program: {
        select: {
          programId: true,
          programCode: true,
          programName: true,
        },
      },
    },
  },
};

function decimalString(value) {
  return value?.toString() ?? null;
}

function relatedTransactionToResponse(transaction) {
  if (!transaction) {
    return null;
  }
  return { ...transaction, amount: decimalString(transaction.amount) };
}

export function walletToResponse(wallet) {
  return { ...wallet, balance: decimalString(wallet.balance) };
}

export function transactionToResponse(transaction) {
  return {
    ...transaction,
    amount: decimalString(transaction.amount),
    balanceBefore: decimalString(transaction.balanceBefore),
    balanceAfter: decimalString(transaction.balanceAfter),
    reversalOf: relatedTransactionToResponse(transaction.reversalOf),
    reversal: relatedTransactionToResponse(transaction.reversal),
  };
}

export function receiptToResponse(transaction) {
  const response = transactionToResponse(transaction);
  return {
    receiptVersion: "GYA-SIM-1",
    issuedAt: new Date(),
    transaction: {
      ...response,
      claim: response.claim
        ? {
            ...response.claim,
            allocation: {
              ...response.claim.allocation,
              amount: decimalString(response.claim.allocation.amount),
            },
          }
        : null,
    },
    simulation: SIMULATION_DISCLOSURE,
  };
}

export function transactionRequestHash(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function generateTransactionReference(prefix) {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `GYA-SIM-${prefix}-${date}-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
}

export function transactionSignedAmount(transaction) {
  const amount = Number(transaction.amount);
  if (["SIMULATED_TRANSFER_OUT", "BENEFIT_REVERSAL"].includes(transaction.transactionType)) {
    return -amount;
  }
  if (["BENEFIT_CREDIT", "SIMULATED_TRANSFER_IN"].includes(transaction.transactionType)) {
    return amount;
  }
  return 0;
}

export function assertWalletActive(wallet) {
  if (wallet.accountStatus !== "ACTIVE") {
    throw new AppError(
      409,
      "SIMULATED_WALLET_NOT_ACTIVE",
      `A simulated wallet with ${wallet.accountStatus} status cannot process transactions.`,
    );
  }
}

export function assertClaimCreditable(claim) {
  if (claim.claimStatus !== "VERIFIED") {
    throw new AppError(
      409,
      "CLAIM_NOT_CREDITABLE",
      "Only a VERIFIED claim can be credited to a simulated wallet.",
    );
  }
  if (claim.disputes?.some((dispute) => ["OPEN", "UNDER_REVIEW", "REFERRED"].includes(dispute.status))) {
    throw new AppError(
      409,
      "ACTIVE_CLAIM_DISPUTE",
      "Resolve the active claim dispute before recording a simulated benefit credit.",
    );
  }
  const verificationMethod = claim.verificationMethod
    ?? (claim.qrVerified ? "QR" : "BIOMETRIC");
  const identityRequirementSatisfied = {
    QR: claim.qrVerified,
    BIOMETRIC: claim.biometricVerified,
    QR_AND_BIOMETRIC: claim.qrVerified && claim.biometricVerified,
    BIOMETRIC_AND_SIGNATURE: claim.biometricVerified && claim.signatureVerified,
    MANUAL: false,
  }[verificationMethod] ?? false;
  if (!identityRequirementSatisfied) {
    throw new AppError(
      409,
      "CLAIM_IDENTITY_NOT_VERIFIED",
      "The claim has not satisfied its configured identity-verification requirement.",
    );
  }
  if (claim.allocation.allocationStatus !== "ALLOCATED") {
    throw new AppError(
      409,
      "ALLOCATION_NOT_CREDITABLE",
      "The claim allocation must be ALLOCATED before simulated credit.",
    );
  }
  if (claim.schedule.status !== "CHECKED_IN") {
    throw new AppError(
      409,
      "SCHEDULE_NOT_CHECKED_IN",
      "The beneficiary schedule must be CHECKED_IN before simulated credit.",
    );
  }
  if (claim.beneficiary.status !== "ACTIVE") {
    throw new AppError(
      409,
      "BENEFICIARY_NOT_ACTIVE",
      "Only an active beneficiary can receive a simulated wallet credit.",
    );
  }
}

export async function getWalletOrThrow(walletId, database = prisma) {
  const wallet = await database.walletAccount.findUnique({
    where: { walletId },
    select: walletPublicSelect,
  });
  if (!wallet) {
    throw new AppError(404, "SIMULATED_WALLET_NOT_FOUND", "Simulated wallet was not found.");
  }
  return wallet;
}

export async function getWalletTransactionOrThrow(walletId, transactionId, database = prisma) {
  const transaction = await database.transaction.findFirst({
    where: { walletId, transactionId },
    select: transactionPublicSelect,
  });
  if (!transaction) {
    throw new AppError(
      404,
      "SIMULATED_TRANSACTION_NOT_FOUND",
      "Simulated wallet transaction was not found.",
    );
  }
  return transaction;
}
