import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
import { distributionAccessWhere } from "../distributions/distribution.policy.js";
import { distributionSelect, distributionToResponse } from "../distributions/distribution.service.js";
import { SIMULATION_DISCLOSURE } from "../wallets/wallet.service.js";
import {
  canViewGlobalFinancialMetrics,
  resolveDashboardBarangay,
} from "./dashboard.policy.js";

export const PHILIPPINE_TIME_ZONE = "Asia/Manila";
export const REPORT_DISCLAIMER = "Prototype compliance-review report only; not an official COA-certified report.";

const QR_SUCCESS_RESULTS = new Set(["VERIFIED", "PENDING_BIOMETRIC"]);
const QR_ANOMALY_RESULTS = Object.freeze([
  "DUPLICATE",
  "INVALID_TOKEN",
  "REVOKED",
  "EXPIRED",
  "INVALID_SCHEDULE",
  "INVALID_ALLOCATION",
]);
const BIOMETRIC_ANOMALY_RESULTS = Object.freeze([
  "NO_MATCH",
  "LIVENESS_FAILED",
  "DUPLICATE",
  "PROFILE_UNAVAILABLE",
  "CONSENT_INVALID",
  "PROCESSOR_ERROR",
]);

function groupCount(groups, key, value) {
  return groups.find((group) => group[key] === value)?._count?._all ?? 0;
}

function totalGroupCount(groups) {
  return groups.reduce((total, group) => total + (group._count?._all ?? 0), 0);
}

function groupAmountCents(groups, predicate) {
  return groups
    .filter(predicate)
    .reduce((total, group) => total + decimalToCents(group._sum?.amount ?? 0), 0n);
}

export function decimalToCents(value) {
  const text = value?.toString?.() ?? String(value ?? 0);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new TypeError("Monetary values must be decimal numbers.");
  }
  const fraction = `${match[3] ?? ""}00`.slice(0, 2);
  const cents = BigInt(match[2]) * 100n + BigInt(fraction);
  return match[1] ? -cents : cents;
}

export function formatMoney(cents) {
  const normalized = typeof cents === "bigint" ? cents : BigInt(cents);
  const negative = normalized < 0n;
  const absolute = negative ? -normalized : normalized;
  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function completionPercentage(completed, total) {
  if (total === 0) return "0.00";
  return ((completed / total) * 100).toFixed(2);
}

export function formatPhilippineTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PHILIPPINE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}+08:00`;
}

function currentPhilippineDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PHILIPPINE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(`${values.year}-${values.month}-${values.day}T00:00:00.000Z`);
}

export function buildDistributionDashboardWhere(filters, staffUser) {
  const barangayId = resolveDashboardBarangay(staffUser, filters.barangayId);
  return {
    ...(filters.distributionId ? { distributionId: filters.distributionId } : {}),
    ...(filters.programId ? { programId: filters.programId } : {}),
    ...(barangayId ? { barangayId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.dateFrom || filters.dateTo ? {
      distributionDate: {
        ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
        ...(filters.dateTo ? { lte: filters.dateTo } : {}),
      },
    } : {}),
  };
}

function relationDistributionWhere(distributionWhere) {
  return { distribution: { is: distributionWhere } };
}

function createdAtWhere(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return {};
  return {
    createdAt: {
      ...(dateFrom ? { gte: dateFrom } : {}),
      ...(dateTo ? { lte: dateTo } : {}),
    },
  };
}

export function calculateFundUtilization(allocationGroups, transactionGroups) {
  const allocated = groupAmountCents(
    allocationGroups,
    (group) => group.allocationStatus !== "CANCELLED",
  );
  const grossCredited = groupAmountCents(
    transactionGroups,
    (group) => group.transactionType === "BENEFIT_CREDIT"
      && ["COMPLETED", "REVERSED"].includes(group.status),
  );
  const completed = groupAmountCents(
    transactionGroups,
    (group) => group.transactionType === "BENEFIT_CREDIT" && group.status === "COMPLETED",
  );
  const reversed = groupAmountCents(
    transactionGroups,
    (group) => group.transactionType === "BENEFIT_REVERSAL" && group.status === "COMPLETED",
  );
  const failed = groupAmountCents(
    transactionGroups,
    (group) => group.status === "FAILED",
  );
  const netCredited = grossCredited - reversed;
  return {
    currency: "PHP",
    allocatedAmount: formatMoney(allocated),
    grossCreditedAmount: formatMoney(grossCredited),
    completedAmount: formatMoney(completed),
    reversedAmount: formatMoney(reversed),
    failedAmount: formatMoney(failed),
    netCreditedAmount: formatMoney(netCredited),
    remainingAmount: formatMoney(allocated - netCredited),
    simulated: true,
    realFundsMoved: false,
  };
}

function countMap(groups, key) {
  return Object.fromEntries(groups.map((group) => [group[key], group._count._all]));
}

function sumCapacity(groups) {
  return groups.reduce((total, group) => total + (group._sum?.capacity ?? 0), 0);
}

function overviewProgramWhere(filters, distributionWhere) {
  const hasDistributionScope = Object.keys(distributionWhere).length > 0;
  return {
    status: "ACTIVE",
    ...(filters.programId ? { programId: filters.programId } : {}),
    ...(hasDistributionScope ? { distributions: { some: distributionWhere } } : {}),
  };
}

export async function getDashboardOverview(filters, staffUser, database = prisma) {
  const distributionWhere = buildDistributionDashboardWhere(filters, staffUser);
  const relatedWhere = relationDistributionWhere(distributionWhere);
  const barangayId = resolveDashboardBarangay(staffUser, filters.barangayId);
  const today = currentPhilippineDate();
  const financialVisible = canViewGlobalFinancialMetrics(staffUser);

  const [
    activeProgramCount,
    approvedEnrollmentCount,
    approvedEnrollments,
    distributionGroups,
    upcomingDistributionCount,
    allocationGroups,
    scheduleGroups,
    claimGroups,
    slotAggregate,
    qrScanGroups,
    biometricGroups,
    duplicateClaimFlagCount,
    transactionGroups,
  ] = await Promise.all([
    database.program.count({ where: overviewProgramWhere(filters, distributionWhere) }),
    database.enrollment.count({
      where: {
        status: "APPROVED",
        ...(filters.programId ? { programId: filters.programId } : {}),
        ...(barangayId ? { beneficiary: { is: { barangayId } } } : {}),
      },
    }),
    database.enrollment.findMany({
      where: {
        status: "APPROVED",
        ...(filters.programId ? { programId: filters.programId } : {}),
        ...(barangayId ? { beneficiary: { is: { barangayId } } } : {}),
      },
      select: { beneficiaryId: true },
      distinct: ["beneficiaryId"],
    }),
    database.distribution.groupBy({
      by: ["status"],
      where: distributionWhere,
      _count: { _all: true },
    }),
    database.distribution.count({
      where: {
        ...distributionWhere,
        distributionDate: {
          ...(distributionWhere.distributionDate ?? {}),
          gte: distributionWhere.distributionDate?.gte ?? today,
        },
        status: { in: ["DRAFT", "OPEN"] },
      },
    }),
    database.distributionAllocation.groupBy({
      by: ["allocationStatus"],
      where: relatedWhere,
      _count: { _all: true },
      _sum: { amount: true },
    }),
    database.schedule.groupBy({
      by: ["status"],
      where: relatedWhere,
      _count: { _all: true },
    }),
    database.claim.groupBy({
      by: ["claimStatus"],
      where: relatedWhere,
      _count: { _all: true },
    }),
    database.distributionSlot.aggregate({
      where: relatedWhere,
      _count: { _all: true },
      _sum: { capacity: true },
    }),
    database.qrScanLog.groupBy({
      by: ["scanResult"],
      where: relatedWhere,
      _count: { _all: true },
    }),
    database.biometricVerificationAttempt.groupBy({
      by: ["result"],
      where: relatedWhere,
      _count: { _all: true },
    }),
    database.claim.count({ where: { ...relatedWhere, isDuplicateFlag: true } }),
    financialVisible
      ? database.transaction.groupBy({
          by: ["transactionType", "status"],
          where: relatedWhere,
          _count: { _all: true },
          _sum: { amount: true },
        })
      : Promise.resolve([]),
  ]);

  const allocationCounts = countMap(allocationGroups, "allocationStatus");
  const scheduleCounts = countMap(scheduleGroups, "status");
  const claimCounts = countMap(claimGroups, "claimStatus");
  const qrCounts = countMap(qrScanGroups, "scanResult");
  const biometricCounts = countMap(biometricGroups, "result");
  const nonCancelledAllocations = totalGroupCount(
    allocationGroups.filter((group) => group.allocationStatus !== "CANCELLED"),
  );
  const claimed = claimCounts.CLAIMED ?? 0;
  const totalCapacity = slotAggregate._sum.capacity ?? 0;
  const activeQueueCount = (scheduleCounts.SCHEDULED ?? 0) + (scheduleCounts.CHECKED_IN ?? 0);
  const duplicateQrAttempts = qrCounts.DUPLICATE ?? 0;
  const duplicateBiometricAttempts = biometricCounts.DUPLICATE ?? 0;
  const invalidQrAttempts = qrScanGroups
    .filter((group) => !QR_SUCCESS_RESULTS.has(group.scanResult) && group.scanResult !== "DUPLICATE")
    .reduce((total, group) => total + group._count._all, 0);

  const overview = {
    generatedAt: formatPhilippineTimestamp(new Date()),
    timeZone: PHILIPPINE_TIME_ZONE,
    scope: {
      global: staffUser.role !== "BARANGAY_FACILITATOR",
      barangayId: barangayId ?? null,
      filters,
    },
    programs: {
      activeProgramCount,
    },
    distributions: {
      totalMatchingDistributionCount: totalGroupCount(distributionGroups),
      openDistributionCount: groupCount(distributionGroups, "status", "OPEN"),
      upcomingDistributionCount,
      statusCounts: countMap(distributionGroups, "status"),
    },
    beneficiaries: {
      approvedBeneficiaryCount: approvedEnrollments.length,
      approvedEnrollmentCount,
      activeAllocationCount: allocationCounts.ALLOCATED ?? 0,
      totalNonCancelledAllocationCount: nonCancelledAllocations,
      scheduledBeneficiaryCount: activeQueueCount,
      verifiedBeneficiaryCount: claimCounts.VERIFIED ?? 0,
      claimedBeneficiaryCount: claimed,
      unclaimedAllocationCount:
        (allocationCounts.PENDING ?? 0) + (allocationCounts.ALLOCATED ?? 0),
      claimCompletionPercentage: completionPercentage(claimed, nonCancelledAllocations),
    },
    queue: {
      slotCount: slotAggregate._count._all,
      totalCapacity,
      scheduledCount: scheduleCounts.SCHEDULED ?? 0,
      checkedInCount: scheduleCounts.CHECKED_IN ?? 0,
      missedCount: scheduleCounts.MISSED ?? 0,
      cancelledCount: scheduleCounts.CANCELLED ?? 0,
      capacityUtilizationPercentage: completionPercentage(activeQueueCount, totalCapacity),
      checkInPercentage: completionPercentage(scheduleCounts.CHECKED_IN ?? 0, activeQueueCount),
    },
    anomalies: {
      duplicateAttemptCount: duplicateQrAttempts + duplicateBiometricAttempts,
      duplicateQrAttemptCount: duplicateQrAttempts,
      duplicateBiometricAttemptCount: duplicateBiometricAttempts,
      duplicateClaimFlagCount,
      invalidQrAttemptCount: invalidQrAttempts,
      biometricNoMatchCount: biometricCounts.NO_MATCH ?? 0,
      livenessFailureCount: biometricCounts.LIVENESS_FAILED ?? 0,
    },
    financialVisibility: financialVisible,
    simulation: SIMULATION_DISCLOSURE,
  };
  if (financialVisible) {
    overview.fundUtilization = calculateFundUtilization(allocationGroups, transactionGroups);
  }
  return overview;
}

export async function getDashboardDistributionOrThrow(
  distributionId,
  staffUser,
  database = prisma,
) {
  const distribution = await database.distribution.findFirst({
    where: { distributionId, ...distributionAccessWhere(staffUser) },
    select: distributionSelect,
  });
  if (!distribution) {
    throw new AppError(404, "DISTRIBUTION_NOT_FOUND", "Distribution event was not found.");
  }
  return distribution;
}

export async function getDistributionDashboardSummary(
  distributionId,
  staffUser,
  database = prisma,
  now = new Date(),
) {
  const distribution = await getDashboardDistributionOrThrow(distributionId, staffUser, database);
  const baseWhere = { distributionId };
  const [
    slotGroups,
    allocationGroups,
    scheduleGroups,
    claimGroups,
    qrTokenGroups,
    expiredActiveQrCount,
    qrScanGroups,
    biometricGroups,
    transactionGroups,
  ] = await Promise.all([
    database.distributionSlot.groupBy({
      by: ["slotStatus"],
      where: baseWhere,
      _count: { _all: true },
      _sum: { capacity: true },
    }),
    database.distributionAllocation.groupBy({
      by: ["allocationStatus"],
      where: baseWhere,
      _count: { _all: true },
      _sum: { amount: true },
    }),
    database.schedule.groupBy({
      by: ["status"],
      where: baseWhere,
      _count: { _all: true },
    }),
    database.claim.groupBy({
      by: ["claimStatus"],
      where: baseWhere,
      _count: { _all: true },
    }),
    database.qrToken.groupBy({
      by: ["qrStatus"],
      where: baseWhere,
      _count: { _all: true },
    }),
    database.qrToken.count({
      where: { distributionId, qrStatus: "ACTIVE", expiresAt: { lte: now } },
    }),
    database.qrScanLog.groupBy({
      by: ["scanResult"],
      where: baseWhere,
      _count: { _all: true },
    }),
    database.biometricVerificationAttempt.groupBy({
      by: ["result"],
      where: baseWhere,
      _count: { _all: true },
    }),
    database.transaction.groupBy({
      by: ["transactionType", "status"],
      where: baseWhere,
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);

  const allocationCounts = countMap(allocationGroups, "allocationStatus");
  const scheduleCounts = countMap(scheduleGroups, "status");
  const claimCounts = countMap(claimGroups, "claimStatus");
  const storedQrCounts = countMap(qrTokenGroups, "qrStatus");
  const qrScanCounts = countMap(qrScanGroups, "scanResult");
  const biometricCounts = countMap(biometricGroups, "result");
  const nonCancelledAllocations = totalGroupCount(
    allocationGroups.filter((group) => group.allocationStatus !== "CANCELLED"),
  );
  const activeQueueCount = (scheduleCounts.SCHEDULED ?? 0) + (scheduleCounts.CHECKED_IN ?? 0);
  const totalCapacity = sumCapacity(slotGroups);
  const invalidQrCount = qrScanGroups
    .filter((group) => !QR_SUCCESS_RESULTS.has(group.scanResult) && group.scanResult !== "DUPLICATE")
    .reduce((total, group) => total + group._count._all, 0);
  const failedTransactionCount = transactionGroups
    .filter((group) => group.status === "FAILED")
    .reduce((total, group) => total + group._count._all, 0);
  const reversedTransactionCount = transactionGroups
    .filter((group) => group.transactionType === "BENEFIT_REVERSAL" && group.status === "COMPLETED")
    .reduce((total, group) => total + group._count._all, 0);

  return {
    generatedAt: formatPhilippineTimestamp(now),
    timeZone: PHILIPPINE_TIME_ZONE,
    distribution: distributionToResponse(distribution),
    beneficiaries: {
      allocatedCount: (allocationCounts.ALLOCATED ?? 0) + (allocationCounts.CLAIMED ?? 0),
      scheduledCount: scheduleCounts.SCHEDULED ?? 0,
      checkedInCount: scheduleCounts.CHECKED_IN ?? 0,
      verifiedCount: claimCounts.VERIFIED ?? 0,
      claimedCount: claimCounts.CLAIMED ?? 0,
      cancelledAllocationCount: allocationCounts.CANCELLED ?? 0,
      cancelledScheduleCount: scheduleCounts.CANCELLED ?? 0,
      unclaimedCount: (allocationCounts.PENDING ?? 0) + (allocationCounts.ALLOCATED ?? 0),
      claimCompletionPercentage: completionPercentage(
        claimCounts.CLAIMED ?? 0,
        nonCancelledAllocations,
      ),
      allocationStatusCounts: allocationCounts,
      scheduleStatusCounts: scheduleCounts,
      claimStatusCounts: claimCounts,
    },
    slots: {
      slotCount: totalGroupCount(slotGroups),
      totalCapacity,
      activeQueueCount,
      capacityUtilizationPercentage: completionPercentage(activeQueueCount, totalCapacity),
      statusCounts: countMap(slotGroups, "slotStatus"),
    },
    qrTokens: {
      generatedCount: totalGroupCount(qrTokenGroups),
      activeCount: Math.max(0, (storedQrCounts.ACTIVE ?? 0) - expiredActiveQrCount),
      usedCount: storedQrCounts.USED ?? 0,
      expiredCount: (storedQrCounts.EXPIRED ?? 0) + expiredActiveQrCount,
      revokedCount: storedQrCounts.REVOKED ?? 0,
    },
    qrScans: {
      verifiedCount:
        (qrScanCounts.VERIFIED ?? 0) + (qrScanCounts.PENDING_BIOMETRIC ?? 0),
      duplicateCount: qrScanCounts.DUPLICATE ?? 0,
      invalidCount: invalidQrCount,
      resultCounts: qrScanCounts,
    },
    biometrics: {
      matchedCount: biometricCounts.MATCHED ?? 0,
      noMatchCount: biometricCounts.NO_MATCH ?? 0,
      livenessFailedCount: biometricCounts.LIVENESS_FAILED ?? 0,
      duplicateCount: biometricCounts.DUPLICATE ?? 0,
      resultCounts: biometricCounts,
      rawCapturesStored: false,
      templatesReturned: false,
    },
    transactions: {
      completedBenefitCreditCount: transactionGroups
        .filter((group) => group.transactionType === "BENEFIT_CREDIT" && group.status === "COMPLETED")
        .reduce((total, group) => total + group._count._all, 0),
      reversedTransactionCount,
      failedTransactionCount,
    },
    fundUtilization: calculateFundUtilization(allocationGroups, transactionGroups),
    simulation: SIMULATION_DISCLOSURE,
    privacy: {
      rawQrTokensReturned: false,
      tokenHashesReturned: false,
      biometricTemplatesReturned: false,
    },
  };
}

function anomalySeverity(category, result) {
  if (category === "TRANSACTION") return result === "FAILED" ? "HIGH" : "MEDIUM";
  if (result === "DUPLICATE") return "HIGH";
  if (["INVALID_TOKEN", "CONSENT_INVALID", "PROCESSOR_ERROR"].includes(result)) return "MEDIUM";
  return "LOW";
}

function anomalyTimestamp(row) {
  return row.scannedAt ?? row.createdAt;
}

function anomalyItem(category, row) {
  const result = row.scanResult ?? row.result ?? row.status ?? row.transactionType ?? "FLAGGED";
  return {
    anomalyId: row.scanLogId ?? row.attemptId ?? row.transactionId ?? row.claimId,
    category,
    result,
    severity: anomalySeverity(category, result),
    distributionId: row.distributionId,
    ...(row.beneficiaryId ? { beneficiaryId: row.beneficiaryId } : {}),
    ...(row.claimId ? { claimId: row.claimId } : {}),
    occurredAt: formatPhilippineTimestamp(anomalyTimestamp(row)),
  };
}

export async function getDistributionAnomalies(
  distributionId,
  staffUser,
  { page = 1, pageSize = 20, dateFrom, dateTo } = {},
  database = prisma,
) {
  await getDashboardDistributionOrThrow(distributionId, staffUser, database);
  const timeWhere = createdAtWhere(dateFrom, dateTo);
  const scannedAt = timeWhere.createdAt ? { scannedAt: timeWhere.createdAt } : {};
  const take = page * pageSize;
  const qrWhere = { distributionId, scanResult: { in: QR_ANOMALY_RESULTS }, ...scannedAt };
  const biometricWhere = {
    distributionId,
    result: { in: BIOMETRIC_ANOMALY_RESULTS },
    ...timeWhere,
  };
  const claimWhere = { distributionId, isDuplicateFlag: true, ...timeWhere };
  const transactionWhere = {
    distributionId,
    ...timeWhere,
    OR: [
      { status: { in: ["FAILED", "REVERSED"] } },
      { transactionType: "BENEFIT_REVERSAL", status: "COMPLETED" },
    ],
  };

  const [qrRows, biometricRows, claimRows, transactionRows, qrTotal, biometricTotal, claimTotal, transactionTotal] = await Promise.all([
    database.qrScanLog.findMany({
      where: qrWhere,
      select: {
        scanLogId: true,
        distributionId: true,
        claimId: true,
        scanResult: true,
        scannedAt: true,
      },
      orderBy: [{ scannedAt: "desc" }, { scanLogId: "desc" }],
      take,
    }),
    database.biometricVerificationAttempt.findMany({
      where: biometricWhere,
      select: {
        attemptId: true,
        distributionId: true,
        beneficiaryId: true,
        claimId: true,
        result: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { attemptId: "desc" }],
      take,
    }),
    database.claim.findMany({
      where: claimWhere,
      select: {
        claimId: true,
        distributionId: true,
        beneficiaryId: true,
        claimStatus: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { claimId: "desc" }],
      take,
    }),
    database.transaction.findMany({
      where: transactionWhere,
      select: {
        transactionId: true,
        distributionId: true,
        beneficiaryId: true,
        claimId: true,
        transactionType: true,
        status: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }, { transactionId: "desc" }],
      take,
    }),
    database.qrScanLog.count({ where: qrWhere }),
    database.biometricVerificationAttempt.count({ where: biometricWhere }),
    database.claim.count({ where: claimWhere }),
    database.transaction.count({ where: transactionWhere }),
  ]);

  const items = [
    ...qrRows.map((row) => anomalyItem("QR_SCAN", row)),
    ...biometricRows.map((row) => anomalyItem("BIOMETRIC", row)),
    ...claimRows.map((row) => anomalyItem("DUPLICATE_CLAIM", { ...row, result: "DUPLICATE" })),
    ...transactionRows.map((row) => anomalyItem("TRANSACTION", row)),
  ].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)
    || right.anomalyId.localeCompare(left.anomalyId));
  const total = qrTotal + biometricTotal + claimTotal + transactionTotal;

  return {
    generatedAt: formatPhilippineTimestamp(new Date()),
    timeZone: PHILIPPINE_TIME_ZONE,
    distributionId,
    anomalies: items.slice((page - 1) * pageSize, page * pageSize),
    summary: {
      total,
      qrAnomalyCount: qrTotal,
      biometricAnomalyCount: biometricTotal,
      duplicateClaimFlagCount: claimTotal,
      transactionAnomalyCount: transactionTotal,
    },
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    privacy: {
      rawQrTokensReturned: false,
      tokenHashesReturned: false,
      faceCapturesReturned: false,
      biometricTemplatesReturned: false,
      deviceInformationReturned: false,
    },
  };
}

export const anomalyResultSets = Object.freeze({
  qr: QR_ANOMALY_RESULTS,
  biometric: BIOMETRIC_ANOMALY_RESULTS,
});
