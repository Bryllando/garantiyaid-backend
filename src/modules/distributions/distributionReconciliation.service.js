import prisma from "../../lib/prisma.js";
import { claimReconciliationException, transactionSignedAmount } from "../wallets/wallet.service.js";

const cents = (value) => Math.round(Number(value ?? 0) * 100);
const money = (value) => (value / 100).toFixed(2);

export async function distributionReconciliation(distribution, database = prisma, now = new Date()) {
  const { distributionId } = distribution;
  const allocations = await database.distributionAllocation.findMany({
      where: { distributionId },
      select: { allocationId: true, beneficiaryId: true, amount: true, allocationStatus: true },
    });
  const claims = await database.claim.findMany({
      where: { distributionId },
      select: {
        claimId: true,
        beneficiaryId: true,
        claimStatus: true,
        releaseMethod: true,
        isDuplicateFlag: true,
        receipt: { select: { receiptId: true } },
        disputes: { where: { status: { in: ["OPEN", "UNDER_REVIEW", "REFERRED"] } }, select: { disputeId: true } },
        releasedAt: true,
        releasedById: true,
        releasedPackageName: true,
        releasedPackageUnit: true,
        releasedQuantity: true,
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
    });
  const distributionTransactions = await database.transaction.findMany({
      where: { distributionId },
      select: {
        transactionId: true,
        transactionType: true,
        status: true,
        amount: true,
        walletId: true,
      },
    });

  const walletIds = [...new Set(distributionTransactions.map((row) => row.walletId))];
  const wallets = walletIds.length === 0
    ? []
    : await database.walletAccount.findMany({
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

  const schedules = await database.schedule.findMany({
    where: { distributionId, status: { in: ["SCHEDULED", "CHECKED_IN"] } },
    select: { beneficiaryId: true, status: true, slot: { select: { slotEnd: true } }, claim: { select: { claimId: true } } },
  });
  const exceptions = [];
  for (const schedule of schedules) {
    if (!schedule.claim && (schedule.status === "CHECKED_IN" || schedule.slot.slotEnd > now)) {
      exceptions.push({ code: "VISIT_OUTCOME_REQUIRED", beneficiaryId: schedule.beneficiaryId });
    }
  }
  for (const claim of claims) {
    if (claim.disputes.length) exceptions.push({ code: "ACTIVE_CLAIM_DISPUTE", claimId: claim.claimId });
    else if (claim.isDuplicateFlag) exceptions.push({ code: "FLAGGED_CLAIM", claimId: claim.claimId });
    if (claim.claimStatus === "PENDING") exceptions.push({ code: "CLAIM_VERIFICATION_INCOMPLETE", claimId: claim.claimId });
    if (claim.claimStatus === "CLAIMED" && !claim.receipt) exceptions.push({ code: "CLAIM_RECEIPT_MISSING", claimId: claim.claimId });
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
  // A voided claim preserves the handover; it is not evidence that goods were returned.
  const handovers = claims.filter((claim) => claim.releaseMethod === "PHYSICAL_GOODS" && claim.releasedAt && claim.releasedById);
  for (const claim of handovers) {
    if (distribution.packageQuantity != null && (claim.releasedQuantity !== distribution.packageQuantity
        || claim.releasedPackageName !== distribution.packageName || claim.releasedPackageUnit !== distribution.packageUnit)) {
      exceptions.push({ code: "PHYSICAL_PACKAGE_MISMATCH", claimId: claim.claimId });
    }
  }
  const physicalPackage = distribution.deliveryMode === "PHYSICAL_GOODS" ? {
    handoverCount: handovers.length,
    name: distribution.packageName ?? null,
    unit: distribution.packageUnit ?? null,
    quantityPerBeneficiary: distribution.packageQuantity ?? null,
    allocatedQuantity: distribution.packageQuantity == null ? null : distribution.packageQuantity
      * allocations.filter((row) => ["ALLOCATED", "CLAIMED"].includes(row.allocationStatus)).length,
    recordedQuantity: handovers.reduce((total, claim) => total + (claim.releasedQuantity ?? 0), 0),
    voidedClaimQuantity: handovers.filter((claim) => claim.claimStatus === "VOIDED")
      .reduce((total, claim) => total + (claim.releasedQuantity ?? 0), 0),
    quantityNotRecordedCount: handovers.filter((claim) => claim.releasedQuantity == null).length,
  } : null;
  const netCreditedAmount = grossCredits - reversals;
  if (netCreditedAmount !== expectedWalletCreditedAmount) {
    exceptions.push({ code: "EVENT_CREDIT_TOTAL_MISMATCH" });
  }
  const operationalCodes = new Set([
    "ACTIVE_CLAIM_DISPUTE", "FLAGGED_CLAIM", "CLAIM_VERIFICATION_INCOMPLETE", "CLAIM_RECEIPT_MISSING", "VISIT_OUTCOME_REQUIRED",
    "VERIFIED_CLAIM_AWAITING_CREDIT",
    "VERIFIED_PHYSICAL_CLAIM_AWAITING_RELEASE",
  ]);
  const hardExceptions = exceptions.filter((row) => !operationalCodes.has(row.code));

  return {
    distributionId,
    unvisitedScheduleCount: schedules.filter((row) => row.status === "SCHEDULED" && !row.claim && row.slot.slotEnd <= now).length,
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
    physicalPackage,
    ledgerBalanced: hardExceptions.length === 0
      && netCreditedAmount === expectedWalletCreditedAmount,
    readyToClose: exceptions.length === 0
      && netCreditedAmount === expectedWalletCreditedAmount,
    exceptions,
  };
}
