import prisma from "../../lib/prisma.js";
import { distributionSlotToResponse } from "../distributions/distributionSlot.service.js";
import { transactionSignedAmount } from "../wallets/wallet.service.js";
import { getMobileOverview } from "./mobileOverview.service.js";

const programSelect = { programId: true, programCode: true, programName: true };
const program = value => ({ id: value.programId, code: value.programCode, name: value.programName });
const iso = value => value?.toISOString() ?? null;
const claimSelect = {
  claimId: true, distributionId: true, scheduleId: true, claimStatus: true,
  verificationMethod: true, verifiedAt: true, claimedAt: true, createdAt: true,
  releaseMethod: true, releasedAt: true, releasedPackageName: true, releasedPackageUnit: true,
  releasedQuantity: true, isDuplicateFlag: true,
  allocation: { select: { amount: true } },
  distribution: { select: { distributionDate: true, deliveryMode: true, program: { select: programSelect } } },
  schedule: { select: { slot: { select: { slotStart: true, slotEnd: true } } } },
  receipt: { select: { receiptNo: true, issuedAt: true } },
  disputes: { where: { status: { in: ["OPEN", "UNDER_REVIEW", "REFERRED"] } }, select: { disputeId: true }, take: 1 },
};

function mobileClaim(claim) {
  return {
    id: claim.claimId, distributionId: claim.distributionId, scheduleId: claim.scheduleId,
    status: claim.claimStatus.toLowerCase(), verificationMethod: claim.verificationMethod.toLowerCase(),
    claimedAt: iso(claim.claimedAt), createdAt: iso(claim.createdAt), verifiedAt: iso(claim.verifiedAt),
    date: distributionSlotToResponse(claim.schedule.slot).slotStart.slice(0, 10),
    amount: Number(claim.allocation.amount), program: program(claim.distribution.program),
    deliveryMode: (claim.releaseMethod ?? claim.distribution.deliveryMode).toLowerCase(),
    releasedAt: iso(claim.releasedAt),
    package: claim.releasedQuantity === null ? null : {
      name: claim.releasedPackageName, unit: claim.releasedPackageUnit, quantity: claim.releasedQuantity,
    },
    receipt: claim.receipt ? { number: claim.receipt.receiptNo, issuedAt: iso(claim.receipt.issuedAt) } : null,
    needsReview: claim.isDuplicateFlag || claim.disputes.length > 0,
  };
}

// Read-only: physical goods remain claim records and never become wallet credits.
export async function getMobileWallet(session) {
  const beneficiaryId = session.account.beneficiaryId;
  return prisma.$transaction(async tx => {
    const ownClaim = { beneficiaryId, allocation: { beneficiaryId }, schedule: { beneficiaryId } };
    const [wallet, claims, transactions, overview] = await Promise.all([
      tx.walletAccount.findUnique({ where: { beneficiaryId }, select: {
        walletId: true, balance: true, currency: true, accountStatus: true, lastTransactionAt: true,
      } }),
      // ponytail: own-account prototype history is unpaginated; add cursor pagination before a large pilot.
      tx.claim.findMany({ where: ownClaim, select: claimSelect, orderBy: [{ updatedAt: "desc" }, { claimId: "desc" }] }),
      tx.transaction.findMany({ where: {
        beneficiaryId, wallet: { beneficiaryId }, claim: ownClaim,
        transactionType: { in: ["BENEFIT_CREDIT", "BENEFIT_REVERSAL"] },
      }, select: {
        transactionId: true, claimId: true, amount: true, transactionType: true, referenceNo: true,
        status: true, createdAt: true, claim: { select: {
          claimStatus: true, claimedAt: true,
          distribution: { select: { distributionDate: true, program: { select: programSelect } } },
        } },
      }, orderBy: [{ createdAt: "desc" }, { transactionId: "desc" }] }),
      getMobileOverview(session, tx),
    ]);
    const history = claims.map(mobileClaim);
    const schedule = overview.nextSchedule;
    let currentClaim = null;
    if (schedule) {
      const record = history.find(claim => claim.scheduleId === schedule.id);
      if (record) {
        const { createdAt, ...current } = record;
        currentClaim = { ...current, queueNumber: schedule.queueNumber, location: schedule.location };
      } else {
        const allocation = await tx.distributionAllocation.findFirstOrThrow({ where: {
          beneficiaryId, distributionId: schedule.distributionId, allocationStatus: "ALLOCATED",
          enrollment: { status: "APPROVED" },
        }, select: { amount: true, distribution: { select: { deliveryMode: true } } } });
        currentClaim = {
          id: null, distributionId: schedule.distributionId, scheduleId: schedule.id,
          status: "not_claimed", verificationMethod: null, claimedAt: null,
          date: schedule.date, queueNumber: schedule.queueNumber, location: schedule.location,
          amount: Number(allocation.amount), program: {
            id: schedule.program.id, code: schedule.program.code, name: schedule.program.name,
          },
          deliveryMode: allocation.distribution.deliveryMode.toLowerCase(),
          verifiedAt: null, releasedAt: null, package: null, receipt: null, needsReview: false,
        };
      }
    }
    return {
      wallet: wallet ? { id: wallet.walletId, balance: Number(wallet.balance), currency: wallet.currency,
        status: wallet.accountStatus.toLowerCase(), lastTransactionAt: iso(wallet.lastTransactionAt) } : null,
      currentClaim, claims: history,
      transactions: transactions.map(entry => ({
        id: entry.transactionId, claimId: entry.claimId, amount: transactionSignedAmount(entry),
        type: entry.transactionType.toLowerCase(), reference: entry.referenceNo,
        status: entry.status.toLowerCase(), createdAt: iso(entry.createdAt),
        claimStatus: entry.claim.claimStatus.toLowerCase(), claimedAt: iso(entry.claim.claimedAt),
        date: entry.claim.distribution.distributionDate.toISOString().slice(0, 10),
        program: program(entry.claim.distribution.program),
      })),
    };
  }, { isolationLevel: "RepeatableRead" });
}
