import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { clientIpAddress } from "../../utils/clientIp.js";
import {
  publishWalletCreditResult,
  publishWalletReversalResult,
} from "../../realtime/publishers.js";
import { idempotencyKeySchema } from "../distributions/distributionAllocation.schemas.js";
import {
  assertWalletManageAllowed,
  assertWalletReadAllowed,
} from "../distributions/distribution.policy.js";
import {
  claimPublicSelect,
  claimToResponse,
  getDistributionClaimParentOrThrow,
} from "../distributions/distributionClaim.service.js";
import {
  SIMULATION_DISCLOSURE,
  assertClaimCreditable,
  beneficiaryWalletSelect,
  claimReconciliationException,
  assertWalletActive,
  generateTransactionReference,
  getWalletOrThrow,
  receiptToResponse,
  receiptTransactionSelect,
  transactionMutationSelect,
  transactionPublicSelect,
  transactionRequestHash,
  transactionSignedAmount,
  transactionToResponse,
  walletMutationSelect,
  walletPublicSelect,
  walletToResponse,
} from "./wallet.service.js";

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireIdempotencyKey(req, operationLabel) {
  const rawKey = req.get("idempotency-key");
  if (!rawKey) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      `An Idempotency-Key UUID header is required for ${operationLabel}.`,
    );
  }
  const result = idempotencyKeySchema.safeParse(rawKey.trim());
  if (!result.success) {
    throw new AppError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be a valid UUID.");
  }
  return result.data;
}

function assertMatchingIdempotencyRequest(record, requestHash) {
  if (record.requestHash !== requestHash) {
    throw new AppError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used with a different simulated-wallet request.",
    );
  }
}

async function findUsableIdempotencyRecord(identity) {
  const record = await prisma.idempotencyRecord.findUnique({
    where: { userId_operation_idempotencyKey: identity },
  });
  if (!record) {
    return null;
  }
  if (record.expiresAt > new Date()) {
    return record;
  }
  await prisma.idempotencyRecord.deleteMany({
    where: { idempotencyRecordId: record.idempotencyRecordId, expiresAt: { lte: new Date() } },
  });
  return null;
}

async function runWalletTransaction(operation) {
  try {
    return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error.code === "P2034") {
      throw new AppError(
        409,
        "SIMULATED_WALLET_CONCURRENT_CHANGE",
        "The simulated wallet changed concurrently. Retry with the same Idempotency-Key.",
      );
    }
    throw error;
  }
}

async function replayOrNull(req, identity, requestHash) {
  await prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  const existing = await findUsableIdempotencyRecord(identity);
  if (!existing) {
    return null;
  }
  assertMatchingIdempotencyRequest(existing, requestHash);
  return existing;
}

async function createWalletForBeneficiary(tx, beneficiaryId, req, now) {
  const existing = await tx.walletAccount.findUnique({
    where: { beneficiaryId },
    select: walletMutationSelect,
  });
  if (existing) {
    return { wallet: existing, created: false };
  }

  const beneficiary = await tx.beneficiary.findUnique({
    where: { beneficiaryId },
    select: { beneficiaryId: true, status: true },
  });
  if (!beneficiary) {
    throw new AppError(404, "BENEFICIARY_NOT_FOUND", "Beneficiary was not found.");
  }
  if (beneficiary.status !== "ACTIVE") {
    throw new AppError(
      409,
      "BENEFICIARY_NOT_ACTIVE",
      "A simulated wallet can only be created for an active beneficiary.",
    );
  }

  const wallet = await tx.walletAccount.create({
    data: {
      beneficiaryId,
      balance: 0,
      currency: "PHP",
      accountStatus: "ACTIVE",
      createdAt: now,
    },
    select: walletMutationSelect,
  });
  await tx.auditLog.create({
    data: {
      userId: req.auth.userId,
      action: "SIMULATED_WALLET_CREATED",
      entityAffected: "WALLET_ACCOUNT",
      recordId: wallet.walletId,
      ipAddress: clientIpAddress(req),
      details: {
        beneficiaryId,
        currency: "PHP",
        simulated: true,
        realFundsMoved: false,
      },
    },
  });
  return { wallet, created: true };
}

function cents(value) {
  return Math.round(Number(value ?? 0) * 100);
}

function money(valueInCents) {
  return (valueInCents / 100).toFixed(2);
}

export const createSimulatedWallet = asyncHandler(async (req, res) => {
  assertWalletManageAllowed(req.staffUser);
  const { beneficiaryId } = req.validatedBody;
  const result = await runWalletTransaction(async (tx) => createWalletForBeneficiary(
    tx,
    beneficiaryId,
    req,
    new Date(),
  ));
  return res.status(result.created ? 201 : 200).json({
    success: true,
    data: {
      wallet: walletToResponse(result.wallet),
      created: result.created,
      simulation: SIMULATION_DISCLOSURE,
    },
  });
});

export const getSimulatedWallet = asyncHandler(async (req, res) => {
  assertWalletReadAllowed(req.staffUser);
  const wallet = await getWalletOrThrow(req.validatedParams.walletId);
  return res.status(200).json({
    success: true,
    data: { wallet: walletToResponse(wallet), simulation: SIMULATION_DISCLOSURE },
  });
});

export const getSimulatedWalletByBeneficiary = asyncHandler(async (req, res) => {
  assertWalletReadAllowed(req.staffUser);
  const { beneficiaryId } = req.validatedParams;
  const [beneficiary, wallet] = await Promise.all([
    prisma.beneficiary.findUnique({
      where: { beneficiaryId },
      select: beneficiaryWalletSelect,
    }),
    prisma.walletAccount.findUnique({
      where: { beneficiaryId },
      select: walletPublicSelect,
    }),
  ]);
  if (!beneficiary) {
    throw new AppError(404, "BENEFICIARY_NOT_FOUND", "Beneficiary was not found.");
  }
  return res.status(200).json({
    success: true,
    data: {
      beneficiary,
      wallet: wallet ? walletToResponse(wallet) : null,
      simulation: SIMULATION_DISCLOSURE,
    },
  });
});

export const listWalletTransactions = asyncHandler(async (req, res) => {
  assertWalletReadAllowed(req.staffUser);
  const { walletId } = req.validatedParams;
  const { page, pageSize, type, status } = req.validatedQuery;
  await getWalletOrThrow(walletId);
  const where = {
    walletId,
    ...(type ? { transactionType: type } : {}),
    ...(status ? { status } : {}),
  };
  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      select: transactionPublicSelect,
      orderBy: [{ createdAt: "desc" }, { transactionId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.transaction.count({ where }),
  ]);
  return res.status(200).json({
    success: true,
    data: {
      transactions: transactions.map(transactionToResponse),
      summary: { matchingTransactionCount: total },
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      simulation: SIMULATION_DISCLOSURE,
    },
  });
});

export const listCreditableClaims = asyncHandler(async (req, res) => {
  assertWalletReadAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { page, pageSize } = req.validatedQuery;
  const distribution = await getDistributionClaimParentOrThrow(distributionId, req.staffUser);
  if (distribution.deliveryMode !== "SIMULATED_WALLET") {
    throw new AppError(
      409,
      "DISTRIBUTION_NOT_SIMULATED_WALLET",
      "Physical-goods distributions are released by the assigned Barangay Facilitator and do not enter the simulated wallet credit queue.",
    );
  }
  if (distribution.status !== "OPEN") {
    throw new AppError(
      409,
      "DISTRIBUTION_NOT_OPEN_FOR_SIMULATED_CREDIT",
      "A verified claim can only be credited while its distribution event is OPEN.",
    );
  }
  const where = {
    distributionId,
    claimStatus: "VERIFIED",
    transactions: { none: { transactionType: "BENEFIT_CREDIT" } },
    disputes: { none: { status: { in: ["OPEN", "UNDER_REVIEW", "REFERRED"] } } },
  };
  const [claims, total] = await Promise.all([
    prisma.claim.findMany({
      where,
      select: claimPublicSelect,
      orderBy: [{ createdAt: "asc" }, { claimId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.claim.count({ where }),
  ]);
  return res.status(200).json({
    success: true,
    data: {
      claims: claims.map(claimToResponse),
      summary: { creditableClaimCount: total },
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      simulation: SIMULATION_DISCLOSURE,
    },
  });
});

export const creditVerifiedClaim = asyncHandler(async (req, res) => {
  assertWalletManageAllowed(req.staffUser);
  const { distributionId, claimId } = req.validatedParams;
  const { description } = req.validatedBody;
  const distribution = await getDistributionClaimParentOrThrow(distributionId, req.staffUser);
  if (distribution.deliveryMode !== "SIMULATED_WALLET") {
    throw new AppError(
      409,
      "DISTRIBUTION_NOT_SIMULATED_WALLET",
      "Only a SIMULATED_WALLET distribution can create a prototype benefit credit.",
    );
  }
  if (distribution.status !== "OPEN") {
    throw new AppError(
      409,
      "DISTRIBUTION_NOT_OPEN_FOR_SIMULATED_CREDIT",
      "A verified claim can only be credited while its distribution event is OPEN.",
    );
  }
  const idempotencyKey = requireIdempotencyKey(req, "simulated benefit credit");
  const operation = `SIMULATED_BENEFIT_CREDIT:${distributionId}:${claimId}`;
  const identity = { userId: req.auth.userId, operation, idempotencyKey };
  const requestHash = transactionRequestHash({ distributionId, claimId, description: description ?? null });
  const existing = await replayOrNull(req, identity, requestHash);
  if (existing) {
    res.set("Idempotency-Replayed", "true");
    return res.status(existing.responseStatus).json(existing.responseBody);
  }

  const result = await runWalletTransaction(async (tx) => {
    const concurrentRecord = await tx.idempotencyRecord.findUnique({
      where: { userId_operation_idempotencyKey: identity },
    });
    if (concurrentRecord) {
      assertMatchingIdempotencyRequest(concurrentRecord, requestHash);
      return { replayed: true, responseStatus: concurrentRecord.responseStatus, responseBody: concurrentRecord.responseBody };
    }

    const currentDistribution = await getDistributionClaimParentOrThrow(
      distributionId,
      req.staffUser,
      tx,
    );
    if (currentDistribution.status !== "OPEN" || currentDistribution.deliveryMode !== "SIMULATED_WALLET") {
      throw new AppError(
        409,
        "DISTRIBUTION_NOT_OPEN_FOR_SIMULATED_CREDIT",
        "This distribution is no longer open for simulated wallet credit.",
      );
    }

    const claimRecord = await tx.claim.findFirst({
      where: { claimId, distributionId },
      select: {
        claimId: true,
        beneficiaryId: true,
        distributionId: true,
        allocationId: true,
        scheduleId: true,
        claimStatus: true,
        verificationMethod: true,
        qrVerified: true,
        biometricVerified: true,
        signatureVerified: true,
        disputes: {
          where: { status: { in: ["OPEN", "UNDER_REVIEW", "REFERRED"] } },
          select: { disputeId: true, status: true },
        },
      },
    });
    if (!claimRecord) {
      throw new AppError(404, "CLAIM_NOT_FOUND", "Claim verification record was not found.");
    }
    const allocation = await tx.distributionAllocation.findUnique({
      where: { allocationId: claimRecord.allocationId },
      select: { allocationId: true, amount: true, allocationStatus: true },
    });
    const schedule = await tx.schedule.findUnique({
      where: { scheduleId: claimRecord.scheduleId },
      select: { scheduleId: true, status: true },
    });
    const beneficiary = await tx.beneficiary.findUnique({
      where: { beneficiaryId: claimRecord.beneficiaryId },
      select: { beneficiaryId: true, status: true },
    });
    const claim = {
      ...claimRecord,
      allocation,
      schedule,
      beneficiary,
      distribution: currentDistribution,
    };
    const priorCredit = await tx.transaction.findFirst({
      where: { claimId, transactionType: "BENEFIT_CREDIT" },
      select: { transactionId: true, referenceNo: true, status: true },
    });
    if (priorCredit) {
      throw new AppError(
        409,
        "CLAIM_ALREADY_CREDITED",
        "This claim already has a simulated benefit-credit ledger entry.",
        priorCredit,
      );
    }
    assertClaimCreditable(claim);

    const now = new Date();
    const walletResult = await createWalletForBeneficiary(tx, claim.beneficiaryId, req, now);
    assertWalletActive(walletResult.wallet);
    const amount = claim.allocation.amount;
    const balanceBefore = walletResult.wallet.balance;
    const wallet = await tx.walletAccount.update({
      where: { walletId: walletResult.wallet.walletId },
      data: { balance: { increment: amount }, lastTransactionAt: now },
      select: walletMutationSelect,
    });

    const claimUpdate = await tx.claim.updateMany({
      where: { claimId, distributionId, claimStatus: "VERIFIED" },
      data: {
        claimStatus: "CLAIMED",
        releaseMethod: "SIMULATED_WALLET",
        releasedById: req.auth.userId,
        releasedAt: now,
        claimedAt: now,
      },
    });
    const allocationUpdate = await tx.distributionAllocation.updateMany({
      where: { allocationId: claim.allocation.allocationId, allocationStatus: "ALLOCATED" },
      data: { allocationStatus: "CLAIMED" },
    });
    if (claimUpdate.count !== 1 || allocationUpdate.count !== 1) {
      throw new AppError(
        409,
        "SIMULATED_CREDIT_CONCURRENT_CHANGE",
        "Claim or allocation state changed during simulated credit.",
      );
    }

    const transaction = await tx.transaction.create({
      data: {
        claimId,
        distributionId,
        walletId: wallet.walletId,
        beneficiaryId: claim.beneficiaryId,
        initiatedById: req.auth.userId,
        amount,
        transactionType: "BENEFIT_CREDIT",
        referenceNo: generateTransactionReference("CREDIT"),
        status: "COMPLETED",
        balanceBefore,
        balanceAfter: wallet.balance,
        description: description ?? "Verified benefit credited to the simulated wallet.",
      },
      select: transactionMutationSelect,
    });

    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "SIMULATED_BENEFIT_CREDIT_COMPLETED",
        entityAffected: "TRANSACTION",
        recordId: transaction.transactionId,
        ipAddress: clientIpAddress(req),
        details: {
          claimId,
          distributionId,
          allocationId: claim.allocation.allocationId,
          beneficiaryId: claim.beneficiaryId,
          walletId: wallet.walletId,
          referenceNo: transaction.referenceNo,
          amount: amount.toString(),
          claimStatus: "CLAIMED",
          allocationStatus: "CLAIMED",
          simulated: true,
          realFundsMoved: false,
        },
      },
    });

    const responseBody = jsonSafe({
      success: true,
      data: {
        transaction: transactionToResponse(transaction),
        wallet: walletToResponse(wallet),
        lifecycle: {
          claimId,
          claimStatus: "CLAIMED",
          allocationId: claim.allocation.allocationId,
          allocationStatus: "CLAIMED",
        },
        simulation: SIMULATION_DISCLOSURE,
      },
    });
    await tx.idempotencyRecord.create({
      data: {
        ...identity,
        requestHash,
        responseStatus: 201,
        responseBody,
        expiresAt: new Date(now.getTime() + env.idempotencyTtlHours * 60 * 60 * 1000),
      },
    });
    return { replayed: false, responseStatus: 201, responseBody };
  });

  res.set("Idempotency-Replayed", String(result.replayed));
  await publishWalletCreditResult(distributionId, result);
  return res.status(result.responseStatus).json(result.responseBody);
});

export const createSimulatedTransfer = asyncHandler(async (req, res) => {
  assertWalletManageAllowed(req.staffUser);
  const { walletId } = req.validatedParams;
  const { recipientBeneficiaryId, amount, description } = req.validatedBody;
  const idempotencyKey = requireIdempotencyKey(req, "an internal simulated transfer");
  const operation = `SIMULATED_WALLET_TRANSFER:${walletId}`;
  const identity = { userId: req.auth.userId, operation, idempotencyKey };
  const amountString = Number(amount).toFixed(2);
  const requestHash = transactionRequestHash({
    walletId,
    recipientBeneficiaryId,
    amount: amountString,
    description: description ?? null,
  });
  const existing = await replayOrNull(req, identity, requestHash);
  if (existing) {
    res.set("Idempotency-Replayed", "true");
    return res.status(existing.responseStatus).json(existing.responseBody);
  }

  const result = await runWalletTransaction(async (tx) => {
    const concurrentRecord = await tx.idempotencyRecord.findUnique({
      where: { userId_operation_idempotencyKey: identity },
    });
    if (concurrentRecord) {
      assertMatchingIdempotencyRequest(concurrentRecord, requestHash);
      return { replayed: true, responseStatus: concurrentRecord.responseStatus, responseBody: concurrentRecord.responseBody };
    }
    const sourceWallet = await tx.walletAccount.findUnique({
      where: { walletId },
      select: walletMutationSelect,
    });
    if (!sourceWallet) {
      throw new AppError(404, "SIMULATED_WALLET_NOT_FOUND", "Source simulated wallet was not found.");
    }
    assertWalletActive(sourceWallet);
    if (sourceWallet.beneficiaryId === recipientBeneficiaryId) {
      throw new AppError(409, "SELF_TRANSFER_NOT_ALLOWED", "A simulated wallet cannot transfer to itself.");
    }
    if (cents(sourceWallet.balance) < cents(amountString)) {
      throw new AppError(
        409,
        "INSUFFICIENT_SIMULATED_BALANCE",
        "The simulated wallet does not have enough balance for this internal transfer.",
      );
    }

    const now = new Date();
    const recipientResult = await createWalletForBeneficiary(tx, recipientBeneficiaryId, req, now);
    assertWalletActive(recipientResult.wallet);
    const sourceUpdate = await tx.walletAccount.updateMany({
      where: { walletId, accountStatus: "ACTIVE", balance: { gte: amountString } },
      data: { balance: { decrement: amountString }, lastTransactionAt: now },
    });
    if (sourceUpdate.count !== 1) {
      throw new AppError(
        409,
        "INSUFFICIENT_SIMULATED_BALANCE",
        "The simulated balance changed before the transfer completed.",
      );
    }
    const recipientWallet = await tx.walletAccount.update({
      where: { walletId: recipientResult.wallet.walletId },
      data: { balance: { increment: amountString }, lastTransactionAt: now },
      select: walletMutationSelect,
    });
    const updatedSourceWallet = await tx.walletAccount.findUniqueOrThrow({
      where: { walletId },
      select: walletMutationSelect,
    });
    const transferGroupId = randomUUID();
    const transferDescription = description ?? "Closed-loop simulated wallet-to-wallet transfer.";
    const sourceTransaction = await tx.transaction.create({
      data: {
        walletId,
        beneficiaryId: sourceWallet.beneficiaryId,
        initiatedById: req.auth.userId,
        amount: amountString,
        transactionType: "SIMULATED_TRANSFER_OUT",
        referenceNo: generateTransactionReference("XFER-OUT"),
        status: "COMPLETED",
        balanceBefore: sourceWallet.balance,
        balanceAfter: updatedSourceWallet.balance,
        transferGroupId,
        description: transferDescription,
      },
      select: transactionMutationSelect,
    });
    const recipientTransaction = await tx.transaction.create({
      data: {
        walletId: recipientWallet.walletId,
        beneficiaryId: recipientWallet.beneficiaryId,
        initiatedById: req.auth.userId,
        amount: amountString,
        transactionType: "SIMULATED_TRANSFER_IN",
        referenceNo: generateTransactionReference("XFER-IN"),
        status: "COMPLETED",
        balanceBefore: recipientResult.wallet.balance,
        balanceAfter: recipientWallet.balance,
        transferGroupId,
        description: transferDescription,
      },
      select: transactionMutationSelect,
    });
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "SIMULATED_INTERNAL_TRANSFER_COMPLETED",
        entityAffected: "TRANSACTION",
        recordId: sourceTransaction.transactionId,
        ipAddress: clientIpAddress(req),
        details: {
          transferGroupId,
          sourceWalletId: walletId,
          sourceBeneficiaryId: sourceWallet.beneficiaryId,
          recipientWalletId: recipientWallet.walletId,
          recipientBeneficiaryId,
          amount: amountString,
          simulated: true,
          realFundsMoved: false,
          externalDestinationAccepted: false,
        },
      },
    });
    const responseBody = jsonSafe({
      success: true,
      data: {
        transferGroupId,
        sourceTransaction: transactionToResponse(sourceTransaction),
        recipientTransaction: transactionToResponse(recipientTransaction),
        sourceWallet: walletToResponse(updatedSourceWallet),
        recipientWallet: walletToResponse(recipientWallet),
        simulation: SIMULATION_DISCLOSURE,
      },
    });
    await tx.idempotencyRecord.create({
      data: {
        ...identity,
        requestHash,
        responseStatus: 201,
        responseBody,
        expiresAt: new Date(now.getTime() + env.idempotencyTtlHours * 60 * 60 * 1000),
      },
    });
    return { replayed: false, responseStatus: 201, responseBody };
  });
  res.set("Idempotency-Replayed", String(result.replayed));
  return res.status(result.responseStatus).json(result.responseBody);
});

export const getTransactionReceipt = asyncHandler(async (req, res) => {
  assertWalletReadAllowed(req.staffUser);
  const { walletId, transactionId } = req.validatedParams;
  const transaction = await prisma.transaction.findFirst({
    where: { walletId, transactionId },
    select: receiptTransactionSelect,
  });
  if (!transaction) {
    throw new AppError(
      404,
      "SIMULATED_TRANSACTION_NOT_FOUND",
      "Simulated wallet transaction was not found.",
    );
  }
  return res.status(200).json({ success: true, data: receiptToResponse(transaction) });
});

export const reverseBenefitCredit = asyncHandler(async (req, res) => {
  assertWalletManageAllowed(req.staffUser);
  const { walletId, transactionId } = req.validatedParams;
  const { reason } = req.validatedBody;
  const idempotencyKey = requireIdempotencyKey(req, "simulated benefit-credit reversal");
  const operation = `SIMULATED_BENEFIT_REVERSAL:${transactionId}`;
  const identity = { userId: req.auth.userId, operation, idempotencyKey };
  const requestHash = transactionRequestHash({ walletId, transactionId, reason });
  const existing = await replayOrNull(req, identity, requestHash);
  if (existing) {
    res.set("Idempotency-Replayed", "true");
    return res.status(existing.responseStatus).json(existing.responseBody);
  }

  const result = await runWalletTransaction(async (tx) => {
    const concurrentRecord = await tx.idempotencyRecord.findUnique({
      where: { userId_operation_idempotencyKey: identity },
    });
    if (concurrentRecord) {
      assertMatchingIdempotencyRequest(concurrentRecord, requestHash);
      return { replayed: true, responseStatus: concurrentRecord.responseStatus, responseBody: concurrentRecord.responseBody };
    }
    const original = await tx.transaction.findFirst({
      where: { walletId, transactionId },
      select: transactionMutationSelect,
    });
    if (!original) {
      throw new AppError(
        404,
        "SIMULATED_TRANSACTION_NOT_FOUND",
        "Simulated wallet transaction was not found.",
      );
    }
    if (original.transactionType !== "BENEFIT_CREDIT") {
      throw new AppError(
        409,
        "TRANSACTION_NOT_REVERSIBLE",
        "Reversal is limited to completed simulated benefit credits.",
      );
    }
    const existingReversal = await tx.transaction.findUnique({
      where: { reversalOfId: original.transactionId },
      select: { transactionId: true },
    });
    if (original.status === "REVERSED" || existingReversal) {
      throw new AppError(
        409,
        "TRANSACTION_ALREADY_REVERSED",
        "This simulated benefit credit has already been reversed.",
      );
    }
    if (original.status !== "COMPLETED") {
      throw new AppError(
        409,
        "TRANSACTION_NOT_REVERSIBLE",
        "Only a COMPLETED simulated benefit credit can be reversed.",
      );
    }
    const wallet = await tx.walletAccount.findUnique({
      where: { walletId },
      select: walletMutationSelect,
    });
    assertWalletActive(wallet);
    if (cents(wallet.balance) < cents(original.amount)) {
      throw new AppError(
        409,
        "REVERSAL_INSUFFICIENT_SIMULATED_BALANCE",
        "The wallet balance is lower than the original credit. Reverse dependent transfers first.",
      );
    }
    const claim = await tx.claim.findUnique({
      where: { claimId: original.claimId },
      select: { claimId: true, claimStatus: true, allocationId: true },
    });
    if (!claim || claim.claimStatus !== "CLAIMED") {
      throw new AppError(
        409,
        "CLAIM_REVERSAL_STATE_INVALID",
        "The linked claim is not in the CLAIMED state required for reversal.",
      );
    }

    const now = new Date();
    const walletUpdate = await tx.walletAccount.updateMany({
      where: { walletId, accountStatus: "ACTIVE", balance: { gte: original.amount } },
      data: { balance: { decrement: original.amount }, lastTransactionAt: now },
    });
    if (walletUpdate.count !== 1) {
      throw new AppError(
        409,
        "REVERSAL_INSUFFICIENT_SIMULATED_BALANCE",
        "The simulated balance changed before reversal completed.",
      );
    }
    const updatedWallet = await tx.walletAccount.findUniqueOrThrow({
      where: { walletId },
      select: walletMutationSelect,
    });
    const reversal = await tx.transaction.create({
      data: {
        claimId: original.claimId,
        distributionId: original.distributionId,
        walletId,
        beneficiaryId: original.beneficiaryId,
        initiatedById: req.auth.userId,
        amount: original.amount,
        transactionType: "BENEFIT_REVERSAL",
        referenceNo: generateTransactionReference("REVERSAL"),
        status: "COMPLETED",
        balanceBefore: wallet.balance,
        balanceAfter: updatedWallet.balance,
        reversalOfId: original.transactionId,
        description: reason,
      },
      select: transactionMutationSelect,
    });
    const reversedOriginal = await tx.transaction.update({
      where: { transactionId: original.transactionId },
      data: { status: "REVERSED" },
      select: transactionMutationSelect,
    });
    await tx.claim.update({
      where: { claimId: claim.claimId },
      data: { claimStatus: "VOIDED" },
    });
    await tx.auditLog.create({
      data: {
        userId: req.auth.userId,
        action: "SIMULATED_BENEFIT_CREDIT_REVERSED",
        entityAffected: "TRANSACTION",
        recordId: reversal.transactionId,
        ipAddress: clientIpAddress(req),
        details: {
          originalTransactionId: original.transactionId,
          reversalTransactionId: reversal.transactionId,
          claimId: original.claimId,
          allocationId: claim.allocationId,
          distributionId: original.distributionId,
          walletId,
          amount: original.amount.toString(),
          reason,
          claimStatus: "VOIDED",
          allocationStatus: "CLAIMED",
          simulated: true,
          realFundsMoved: false,
        },
      },
    });
    const responseBody = jsonSafe({
      success: true,
      data: {
        originalTransaction: transactionToResponse(reversedOriginal),
        reversalTransaction: transactionToResponse(reversal),
        wallet: walletToResponse(updatedWallet),
        lifecycle: {
          claimId: claim.claimId,
          claimStatus: "VOIDED",
          allocationId: claim.allocationId,
          allocationStatus: "CLAIMED",
        },
        simulation: SIMULATION_DISCLOSURE,
      },
    });
    await tx.idempotencyRecord.create({
      data: {
        ...identity,
        requestHash,
        responseStatus: 201,
        responseBody,
        expiresAt: new Date(now.getTime() + env.idempotencyTtlHours * 60 * 60 * 1000),
      },
    });
    return { replayed: false, responseStatus: 201, responseBody };
  });
  res.set("Idempotency-Replayed", String(result.replayed));
  await publishWalletReversalResult(result);
  return res.status(result.responseStatus).json(result.responseBody);
});

export const listDistributionTransactions = asyncHandler(async (req, res) => {
  assertWalletReadAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const { page, pageSize, type, status, beneficiaryId, claimId } = req.validatedQuery;
  await getDistributionClaimParentOrThrow(distributionId, req.staffUser);
  const where = {
    distributionId,
    ...(type ? { transactionType: type } : {}),
    ...(status ? { status } : {}),
    ...(beneficiaryId ? { beneficiaryId } : {}),
    ...(claimId ? { claimId } : {}),
  };
  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      select: transactionPublicSelect,
      orderBy: [{ createdAt: "desc" }, { transactionId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.transaction.count({ where }),
  ]);
  return res.status(200).json({
    success: true,
    data: {
      transactions: transactions.map(transactionToResponse),
      summary: { matchingTransactionCount: total },
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      simulation: SIMULATION_DISCLOSURE,
    },
  });
});

export const reconcileDistribution = asyncHandler(async (req, res) => {
  assertWalletReadAllowed(req.staffUser);
  const { distributionId } = req.validatedParams;
  const distribution = await getDistributionClaimParentOrThrow(distributionId, req.staffUser);
  const [allocations, claims, distributionTransactions] = await Promise.all([
    prisma.distributionAllocation.findMany({
      where: { distributionId },
      select: { allocationId: true, beneficiaryId: true, amount: true, allocationStatus: true },
    }),
    prisma.claim.findMany({
      where: { distributionId },
      select: {
        claimId: true,
        beneficiaryId: true,
        claimStatus: true,
        releaseMethod: true,
        releasedAt: true,
        releasedById: true,
        allocation: { select: { allocationId: true, amount: true, allocationStatus: true } },
        transactions: {
          where: { transactionType: { in: ["BENEFIT_CREDIT", "BENEFIT_REVERSAL"] } },
          select: {
            transactionId: true,
            transactionType: true,
            status: true,
            amount: true,
            walletId: true,
          },
        },
      },
    }),
    prisma.transaction.findMany({
      where: { distributionId },
      select: {
        transactionId: true,
        transactionType: true,
        status: true,
        amount: true,
        walletId: true,
      },
    }),
  ]);

  const walletIds = [...new Set(distributionTransactions.map((row) => row.walletId))];
  const wallets = walletIds.length === 0
    ? []
    : await prisma.walletAccount.findMany({
        where: { walletId: { in: walletIds } },
        select: {
          walletId: true,
          beneficiaryId: true,
          balance: true,
          transactions: {
            where: { status: { in: ["COMPLETED", "REVERSED"] } },
            select: { transactionType: true, amount: true, status: true },
          },
        },
      });

  const exceptions = [];
  for (const claim of claims) {
    const exception = claimReconciliationException(claim, distribution.deliveryMode);
    if (exception) exceptions.push(exception);
  }
  for (const wallet of wallets) {
    const ledgerBalance = wallet.transactions.reduce(
      (total, transaction) => total + cents(transactionSignedAmount(transaction)),
      0,
    );
    if (ledgerBalance !== cents(wallet.balance)) {
      exceptions.push({
        code: "WALLET_LEDGER_BALANCE_MISMATCH",
        walletId: wallet.walletId,
        beneficiaryId: wallet.beneficiaryId,
        storedBalance: wallet.balance.toString(),
        calculatedBalance: money(ledgerBalance),
      });
    }
  }

  const grossCredits = distributionTransactions
    .filter((row) => row.transactionType === "BENEFIT_CREDIT" && ["COMPLETED", "REVERSED"].includes(row.status))
    .reduce((total, row) => total + cents(row.amount), 0);
  const reversals = distributionTransactions
    .filter((row) => row.transactionType === "BENEFIT_REVERSAL" && row.status === "COMPLETED")
    .reduce((total, row) => total + cents(row.amount), 0);
  const totalClaimedAmount = claims
    .filter((claim) => claim.claimStatus === "CLAIMED")
    .reduce((total, claim) => total + cents(claim.allocation.amount), 0);
  const expectedWalletCreditedAmount = claims
    .filter((claim) => (
      claim.claimStatus === "CLAIMED"
      && (claim.releaseMethod ?? distribution.deliveryMode) === "SIMULATED_WALLET"
    ))
    .reduce((total, claim) => total + cents(claim.allocation.amount), 0);
  const physicalReleasedClaims = claims.filter((claim) => (
    claim.claimStatus === "CLAIMED"
    && (claim.releaseMethod ?? distribution.deliveryMode) === "PHYSICAL_GOODS"
    && claim.releasedAt
    && claim.releasedById
  ));
  const physicalReleasedAmount = physicalReleasedClaims
    .reduce((total, claim) => total + cents(claim.allocation.amount), 0);
  const netCreditedAmount = grossCredits - reversals;
  const awaitingSettlementCodes = new Set([
    "VERIFIED_CLAIM_AWAITING_CREDIT",
    "VERIFIED_PHYSICAL_CLAIM_AWAITING_RELEASE",
  ]);
  const hardExceptions = exceptions.filter((row) => !awaitingSettlementCodes.has(row.code));

  return res.status(200).json({
    success: true,
    data: {
      reconciliation: {
        distributionId,
        deliveryMode: distribution.deliveryMode,
        allocationCount: allocations.length,
        allocatedAmount: money(allocations.reduce((total, row) => total + cents(row.amount), 0)),
        claimCounts: {
          VERIFIED: claims.filter((row) => row.claimStatus === "VERIFIED").length,
          CLAIMED: claims.filter((row) => row.claimStatus === "CLAIMED").length,
          VOIDED: claims.filter((row) => row.claimStatus === "VOIDED").length,
        },
        completedBenefitCreditCount: distributionTransactions.filter(
          (row) => row.transactionType === "BENEFIT_CREDIT" && row.status === "COMPLETED",
        ).length,
        reversedBenefitCreditCount: distributionTransactions.filter(
          (row) => row.transactionType === "BENEFIT_CREDIT" && row.status === "REVERSED",
        ).length,
        grossCreditedAmount: money(grossCredits),
        reversedAmount: money(reversals),
        netCreditedAmount: money(netCreditedAmount),
        expectedClaimedAmount: money(expectedWalletCreditedAmount),
        expectedWalletCreditedAmount: money(expectedWalletCreditedAmount),
        totalClaimedAmount: money(totalClaimedAmount),
        physicalReleasedCount: physicalReleasedClaims.length,
        physicalReleasedAmount: money(physicalReleasedAmount),
        ledgerBalanced: hardExceptions.length === 0
          && netCreditedAmount === expectedWalletCreditedAmount,
        readyToClose: exceptions.length === 0
          && netCreditedAmount === expectedWalletCreditedAmount,
        exceptions,
      },
      simulation: SIMULATION_DISCLOSURE,
    },
  });
});
