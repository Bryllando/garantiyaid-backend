import prisma from "../../lib/prisma.js";
import {
  PHILIPPINE_TIME_ZONE,
  REPORT_DISCLAIMER,
  buildDistributionDashboardWhere,
  calculateFundUtilization,
  decimalToCents,
  formatMoney,
  formatPhilippineTimestamp,
  getDashboardDistributionOrThrow,
  getDistributionAnomalies,
  getDistributionDashboardSummary,
} from "../dashboard/dashboard.service.js";
import { distributionSelect, distributionToResponse } from "../distributions/distribution.service.js";
import { SIMULATION_DISCLOSURE } from "../wallets/wallet.service.js";
import { createCsv, safeDistributionExportFilename } from "./csv.service.js";

export const DISTRIBUTION_EXPORT_COLUMNS = Object.freeze([
  { key: "report_version", label: "report_version" },
  { key: "prototype_disclaimer", label: "prototype_disclaimer" },
  { key: "generated_at_ph", label: "generated_at_ph" },
  { key: "distribution_id", label: "distribution_id" },
  { key: "distribution_title", label: "distribution_title" },
  { key: "distribution_date", label: "distribution_date" },
  { key: "program_code", label: "program_code" },
  { key: "program_name", label: "program_name" },
  { key: "barangay_code", label: "barangay_code" },
  { key: "barangay_name", label: "barangay_name" },
  { key: "location", label: "location" },
  { key: "distribution_status", label: "distribution_status" },
  { key: "verification_requirement", label: "verification_requirement" },
  { key: "beneficiary_id", label: "beneficiary_id" },
  { key: "beneficiary_name", label: "beneficiary_name" },
  { key: "allocation_id", label: "allocation_id" },
  { key: "allocation_status", label: "allocation_status" },
  { key: "allocated_amount_php", label: "allocated_amount_php" },
  { key: "schedule_id", label: "schedule_id" },
  { key: "slot_start_ph", label: "slot_start_ph" },
  { key: "slot_end_ph", label: "slot_end_ph" },
  { key: "queue_number", label: "queue_number" },
  { key: "schedule_status", label: "schedule_status" },
  { key: "claim_id", label: "claim_id" },
  { key: "claim_status", label: "claim_status" },
  { key: "verification_method", label: "verification_method" },
  { key: "qr_verified", label: "qr_verified" },
  { key: "biometric_verified", label: "biometric_verified" },
  { key: "claimed_at_ph", label: "claimed_at_ph" },
  { key: "benefit_credit_status", label: "benefit_credit_status" },
  { key: "benefit_credit_reference", label: "benefit_credit_reference" },
  { key: "credited_amount_php", label: "credited_amount_php" },
  { key: "reversal_reference", label: "reversal_reference" },
  { key: "reversed_amount_php", label: "reversed_amount_php" },
  { key: "net_simulated_amount_php", label: "net_simulated_amount_php" },
  { key: "simulated", label: "simulated" },
  { key: "real_funds_moved", label: "real_funds_moved" },
]);

function beneficiaryName(beneficiary) {
  return [beneficiary.firstName, beneficiary.middleName, beneficiary.lastName]
    .filter(Boolean)
    .join(" ");
}

function reportEnvelope(type, distributionId, data, generatedAt = new Date()) {
  return {
    reportType: type,
    reportVersion: "GYA-PHASE8-1",
    generatedAt: formatPhilippineTimestamp(generatedAt),
    timeZone: PHILIPPINE_TIME_ZONE,
    distributionId,
    disclaimer: REPORT_DISCLAIMER,
    data,
  };
}

function timeFilter(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return {};
  return {
    createdAt: {
      ...(dateFrom ? { gte: dateFrom } : {}),
      ...(dateTo ? { lte: dateTo } : {}),
    },
  };
}

export async function generateDistributionSummaryReport(
  distributionId,
  staffUser,
  database = prisma,
) {
  const summary = await getDistributionDashboardSummary(
    distributionId,
    staffUser,
    database,
  );
  return reportEnvelope("DISTRIBUTION_SUMMARY", distributionId, summary);
}

export async function generateClaimStatusReport(
  distributionId,
  staffUser,
  { page, pageSize, status, dateFrom, dateTo },
  database = prisma,
) {
  await getDashboardDistributionOrThrow(distributionId, staffUser, database);
  const where = {
    distributionId,
    ...(status ? { claimStatus: status } : {}),
    ...timeFilter(dateFrom, dateTo),
  };
  const [claims, total, statusGroups] = await Promise.all([
    database.claim.findMany({
      where,
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
        isDuplicateFlag: true,
        claimedAt: true,
        createdAt: true,
        beneficiary: {
          select: {
            firstName: true,
            middleName: true,
            lastName: true,
            barangayId: true,
          },
        },
        allocation: { select: { amount: true, allocationStatus: true } },
        schedule: {
          select: {
            queueNumber: true,
            status: true,
            slot: { select: { slotStart: true, slotEnd: true } },
          },
        },
      },
      orderBy: [{ createdAt: "asc" }, { claimId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    database.claim.count({ where }),
    database.claim.groupBy({
      by: ["claimStatus"],
      where: { distributionId, ...timeFilter(dateFrom, dateTo) },
      _count: { _all: true },
    }),
  ]);
  const rows = claims.map((claim) => ({
    claimId: claim.claimId,
    beneficiaryId: claim.beneficiaryId,
    beneficiaryName: beneficiaryName(claim.beneficiary),
    barangayId: claim.beneficiary.barangayId,
    allocationId: claim.allocationId,
    allocatedAmount: formatMoney(decimalToCents(claim.allocation.amount)),
    allocationStatus: claim.allocation.allocationStatus,
    scheduleId: claim.scheduleId,
    queueNumber: claim.schedule.queueNumber,
    scheduleStatus: claim.schedule.status,
    slotStart: formatPhilippineTimestamp(claim.schedule.slot.slotStart),
    slotEnd: formatPhilippineTimestamp(claim.schedule.slot.slotEnd),
    claimStatus: claim.claimStatus,
    verificationMethod: claim.verificationMethod,
    qrVerified: claim.qrVerified,
    biometricVerified: claim.biometricVerified,
    duplicateFlag: claim.isDuplicateFlag,
    claimedAt: formatPhilippineTimestamp(claim.claimedAt),
    recordedAt: formatPhilippineTimestamp(claim.createdAt),
  }));
  return reportEnvelope("CLAIM_STATUS", distributionId, {
    claims: rows,
    summary: {
      matchingClaimCount: total,
      statusCounts: Object.fromEntries(
        statusGroups.map((group) => [group.claimStatus, group._count._all]),
      ),
    },
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    privacy: {
      contactDetailsReturned: false,
      governmentIdentifiersReturned: false,
      biometricScoresReturned: false,
    },
  });
}

export async function generateQueueScheduleReport(
  distributionId,
  staffUser,
  { page, pageSize, status, dateFrom, dateTo },
  database = prisma,
) {
  await getDashboardDistributionOrThrow(distributionId, staffUser, database);
  const where = {
    distributionId,
    ...(status ? { status } : {}),
    ...timeFilter(dateFrom, dateTo),
  };
  const [schedules, total, statusGroups] = await Promise.all([
    database.schedule.findMany({
      where,
      select: {
        scheduleId: true,
        beneficiaryId: true,
        slotId: true,
        queueNumber: true,
        status: true,
        assignedByAi: true,
        createdAt: true,
        beneficiary: {
          select: {
            firstName: true,
            middleName: true,
            lastName: true,
            barangayId: true,
          },
        },
        slot: {
          select: {
            slotStart: true,
            slotEnd: true,
            capacity: true,
            slotStatus: true,
          },
        },
        claim: { select: { claimId: true, claimStatus: true } },
      },
      orderBy: [{ slot: { slotStart: "asc" } }, { queueNumber: "asc" }, { scheduleId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    database.schedule.count({ where }),
    database.schedule.groupBy({
      by: ["status"],
      where: { distributionId, ...timeFilter(dateFrom, dateTo) },
      _count: { _all: true },
    }),
  ]);
  const rows = schedules.map((schedule) => ({
    scheduleId: schedule.scheduleId,
    beneficiaryId: schedule.beneficiaryId,
    beneficiaryName: beneficiaryName(schedule.beneficiary),
    barangayId: schedule.beneficiary.barangayId,
    slotId: schedule.slotId,
    slotStart: formatPhilippineTimestamp(schedule.slot.slotStart),
    slotEnd: formatPhilippineTimestamp(schedule.slot.slotEnd),
    slotCapacity: schedule.slot.capacity,
    slotStatus: schedule.slot.slotStatus,
    queueNumber: schedule.queueNumber,
    scheduleStatus: schedule.status,
    assignedByAi: schedule.assignedByAi,
    claimId: schedule.claim?.claimId ?? null,
    claimStatus: schedule.claim?.claimStatus ?? null,
    recordedAt: formatPhilippineTimestamp(schedule.createdAt),
  }));
  return reportEnvelope("QUEUE_SCHEDULE", distributionId, {
    schedules: rows,
    summary: {
      matchingScheduleCount: total,
      statusCounts: Object.fromEntries(
        statusGroups.map((group) => [group.status, group._count._all]),
      ),
    },
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    privacy: {
      contactDetailsReturned: false,
      governmentIdentifiersReturned: false,
    },
  });
}

export async function generateAnomalyReport(
  distributionId,
  staffUser,
  filters,
  database = prisma,
) {
  const anomalies = await getDistributionAnomalies(
    distributionId,
    staffUser,
    filters,
    database,
  );
  return reportEnvelope("ANOMALY", distributionId, anomalies);
}

function groupsForDistribution(groups, distributionId) {
  return groups.filter((group) => group.distributionId === distributionId);
}

export async function generateFundUtilizationReport(
  filters,
  staffUser,
  database = prisma,
) {
  const { page, pageSize, ...scopeFilters } = filters;
  const distributionWhere = buildDistributionDashboardWhere(scopeFilters, staffUser);
  const relationWhere = { distribution: { is: distributionWhere } };
  const [distributions, total, totalAllocationGroups, totalTransactionGroups] = await Promise.all([
    database.distribution.findMany({
      where: distributionWhere,
      select: distributionSelect,
      orderBy: [{ distributionDate: "desc" }, { distributionId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    database.distribution.count({ where: distributionWhere }),
    database.distributionAllocation.groupBy({
      by: ["allocationStatus"],
      where: relationWhere,
      _count: { _all: true },
      _sum: { amount: true },
    }),
    database.transaction.groupBy({
      by: ["transactionType", "status"],
      where: relationWhere,
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);
  const pageDistributionIds = distributions.map((row) => row.distributionId);
  const [pageAllocationGroups, pageTransactionGroups] = pageDistributionIds.length === 0
    ? [[], []]
    : await Promise.all([
    database.distributionAllocation.groupBy({
      by: ["distributionId", "allocationStatus"],
      where: { distributionId: { in: pageDistributionIds } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    database.transaction.groupBy({
      by: ["distributionId", "transactionType", "status"],
      where: { distributionId: { in: pageDistributionIds } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);

  const rows = distributions.map((distribution) => ({
    distribution: distributionToResponse(distribution),
    utilization: calculateFundUtilization(
      groupsForDistribution(pageAllocationGroups, distribution.distributionId),
      groupsForDistribution(pageTransactionGroups, distribution.distributionId),
    ),
  }));
  return reportEnvelope("SIMULATED_FUND_UTILIZATION", null, {
    distributions: rows,
    totals: calculateFundUtilization(totalAllocationGroups, totalTransactionGroups),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    simulation: SIMULATION_DISCLOSURE,
  });
}

function allocationExportRow({
  allocation,
  distribution,
  schedule,
  claim,
  transactions,
  generatedAt,
}) {
  const credit = transactions.find((transaction) => transaction.transactionType === "BENEFIT_CREDIT");
  const reversal = transactions.find((transaction) => transaction.transactionType === "BENEFIT_REVERSAL");
  const credited = credit ? decimalToCents(credit.amount) : 0n;
  const reversed = reversal?.status === "COMPLETED" ? decimalToCents(reversal.amount) : 0n;
  return {
    report_version: "GYA-PHASE8-1",
    prototype_disclaimer: REPORT_DISCLAIMER,
    generated_at_ph: formatPhilippineTimestamp(generatedAt),
    distribution_id: distribution.distributionId,
    distribution_title: distribution.title,
    distribution_date: distribution.distributionDate.toISOString().slice(0, 10),
    program_code: distribution.program.programCode,
    program_name: distribution.program.programName,
    barangay_code: distribution.barangay.barangayCode ?? "",
    barangay_name: distribution.barangay.barangayName,
    location: distribution.location,
    distribution_status: distribution.status,
    verification_requirement: distribution.verificationRequirement,
    beneficiary_id: allocation.beneficiaryId,
    beneficiary_name: beneficiaryName(allocation.beneficiary),
    allocation_id: allocation.allocationId,
    allocation_status: allocation.allocationStatus,
    allocated_amount_php: formatMoney(decimalToCents(allocation.amount)),
    schedule_id: schedule?.scheduleId ?? "",
    slot_start_ph: formatPhilippineTimestamp(schedule?.slot.slotStart),
    slot_end_ph: formatPhilippineTimestamp(schedule?.slot.slotEnd),
    queue_number: schedule?.queueNumber ?? "",
    schedule_status: schedule?.status ?? "UNSCHEDULED",
    claim_id: claim?.claimId ?? "",
    claim_status: claim?.claimStatus ?? "UNCLAIMED",
    verification_method: claim?.verificationMethod ?? "",
    qr_verified: claim?.qrVerified ?? false,
    biometric_verified: claim?.biometricVerified ?? false,
    claimed_at_ph: formatPhilippineTimestamp(claim?.claimedAt),
    benefit_credit_status: credit?.status ?? "NOT_CREDITED",
    benefit_credit_reference: credit?.referenceNo ?? "",
    credited_amount_php: formatMoney(credited),
    reversal_reference: reversal?.referenceNo ?? "",
    reversed_amount_php: formatMoney(reversed),
    net_simulated_amount_php: formatMoney(credited - reversed),
    simulated: true,
    real_funds_moved: false,
  };
}

export async function generateDistributionCsvExport(
  distributionId,
  staffUser,
  database = prisma,
) {
  const distribution = await getDashboardDistributionOrThrow(distributionId, staffUser, database);
  const [allocations, schedules, claims, transactions] = await Promise.all([
    database.distributionAllocation.findMany({
      where: { distributionId },
      select: {
        allocationId: true,
        beneficiaryId: true,
        amount: true,
        allocationStatus: true,
        beneficiary: {
          select: { firstName: true, middleName: true, lastName: true },
        },
      },
      orderBy: [{ allocatedAt: "asc" }, { allocationId: "asc" }],
    }),
    database.schedule.findMany({
      where: { distributionId },
      select: {
        scheduleId: true,
        beneficiaryId: true,
        queueNumber: true,
        status: true,
        slot: { select: { slotStart: true, slotEnd: true } },
      },
    }),
    database.claim.findMany({
      where: { distributionId },
      select: {
        claimId: true,
        beneficiaryId: true,
        claimStatus: true,
        verificationMethod: true,
        qrVerified: true,
        biometricVerified: true,
        claimedAt: true,
      },
    }),
    database.transaction.findMany({
      where: {
        distributionId,
        transactionType: { in: ["BENEFIT_CREDIT", "BENEFIT_REVERSAL"] },
      },
      select: {
        claimId: true,
        transactionType: true,
        referenceNo: true,
        amount: true,
        status: true,
      },
      orderBy: [{ createdAt: "asc" }, { transactionId: "asc" }],
    }),
  ]);
  const schedulesByBeneficiary = new Map(schedules.map((row) => [row.beneficiaryId, row]));
  const claimsByBeneficiary = new Map(claims.map((row) => [row.beneficiaryId, row]));
  const transactionsByClaim = new Map();
  for (const transaction of transactions) {
    const current = transactionsByClaim.get(transaction.claimId) ?? [];
    current.push(transaction);
    transactionsByClaim.set(transaction.claimId, current);
  }
  const generatedAt = new Date();
  const rows = allocations.map((allocation) => {
    const claim = claimsByBeneficiary.get(allocation.beneficiaryId) ?? null;
    return allocationExportRow({
      allocation,
      distribution,
      schedule: schedulesByBeneficiary.get(allocation.beneficiaryId) ?? null,
      claim,
      transactions: claim ? (transactionsByClaim.get(claim.claimId) ?? []) : [],
      generatedAt,
    });
  });
  return {
    csv: createCsv(DISTRIBUTION_EXPORT_COLUMNS, rows),
    filename: safeDistributionExportFilename(distribution),
    rowCount: rows.length,
    generatedAt: formatPhilippineTimestamp(generatedAt),
    distribution,
  };
}
