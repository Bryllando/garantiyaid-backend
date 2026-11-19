import test from "node:test";
import assert from "node:assert/strict";
import { reportSnapshotQuerySchema } from "../src/modules/reports/report.schemas.js";
import { collectReportPages, generateReportSnapshot, reportFacts } from "../src/modules/reports/reportSnapshot.service.js";
import { explainReportFacts } from "../src/modules/reports/report.ai.js";
import { getAuditExport } from "../src/modules/audit/audit.service.js";

const distributionId = "11111111-1111-4111-8111-111111111111";
const actor = { role: "SYSTEM_ADMIN", userId: "admin" };
const date = new Date("2026-11-17T01:00:00Z");
const distribution = { distributionId, distributionDate: date, startTime: date, endTime: date, title: "Assistance event", deliveryMode: "SIMULATED_WALLET", program: { programName: "Assistance" }, barangay: { barangayName: "Apas" } };

function databaseFixture() {
  const empty = () => ({ findMany: async () => [], groupBy: async () => [], count: async () => 0 });
  const database = {
    distribution: { findFirst: async () => distribution, findMany: async () => [distribution], count: async () => 1 },
    distributionSlot: empty(), distributionAllocation: empty(), schedule: empty(), claim: empty(), qrToken: empty(), qrScanLog: empty(), biometricVerificationAttempt: empty(), transaction: empty(),
  };
  database.$transaction = async (operation, options) => {
    assert.equal(options.isolationLevel, "RepeatableRead");
    return operation(database);
  };
  return database;
}

test("snapshot coverage reuses report-specific date and status validation", () => {
  const claims = reportSnapshotQuerySchema.parse({ type: "CLAIMS", distributionId, status: " claimed ", dateFrom: "2026-11-17", dateTo: "2026-11-17" });
  assert.equal(claims.filters.status, "CLAIMED");
  assert.equal(claims.filters.dateFrom.toISOString(), "2026-11-16T16:00:00.000Z");
  assert.equal(claims.filters.dateTo.toISOString(), "2026-11-17T15:59:59.999Z");
  assert.equal(reportSnapshotQuerySchema.safeParse({ type: "CLAIMS" }).success, false);
  assert.equal(reportSnapshotQuerySchema.safeParse({ type: "SUMMARY", distributionId, status: "OPEN" }).success, false);
  assert.equal(reportSnapshotQuerySchema.safeParse({ type: "CLAIMS", distributionId, status: "OPEN" }).success, false);
  assert.equal(reportSnapshotQuerySchema.safeParse({ type: "FUNDS", dateFrom: "2026-11-18", dateTo: "2026-11-17" }).success, false);
  assert.equal(reportSnapshotQuerySchema.safeParse({ type: "FUNDS", pageSize: 100000 }).success, false);
});

test("complete snapshots include rows beyond a page and reject incomplete responses", async () => {
  const source = Array.from({ length: 137 }, (_, claimId) => ({ claimId }));
  const reads = [];
  const complete = await collectReportPages(async (page, pageSize) => {
    reads.push({ page, pageSize });
    return { data: { claims: source.slice(0, pageSize), pagination: { total: source.length } } };
  }, "claims");
  assert.equal(complete.data.claims.length, 137);
  assert.deepEqual(reads, [{ page: 1, pageSize: 100 }, { page: 1, pageSize: 137 }]);
  await assert.rejects(collectReportPages(async () => ({ data: { claims: [], pagination: { total: 1 } } }), "claims"), { code: "REPORT_INCOMPLETE" });
});

test("summary packages share one database snapshot and include every supporting report", async () => {
  const database = databaseFixture();
  let transactions = 0;
  const transaction = database.$transaction;
  database.$transaction = (...args) => { transactions++; return transaction(...args); };
  const report = await generateReportSnapshot(reportSnapshotQuerySchema.parse({ type: "SUMMARY", distributionId }), actor, database);
  assert.equal(transactions, 1);
  assert.equal(report.snapshotComplete, true);
  assert.deepEqual(Object.keys(report.supportingReports), ["CLAIMS", "SCHEDULES", "ANOMALIES", "FUNDS"]);
  for (const supporting of Object.values(report.supportingReports)) assert.equal(supporting.generatedAt, report.generatedAt);
  assert.equal(report.supportingReports.FUNDS.data.distributions.length, 1);
  assert.match(reportFacts(report).find(fact => fact.id === "completion").explanation, /0 claims.*0.00%.*0 non-cancelled/);
  await assert.rejects(generateReportSnapshot({ scope: { type: "SUMMARY", distributionId }, filters: {} }, { role: "BARANGAY_FACILITATOR" }, database), { code: "FORBIDDEN" });
});

test("claim snapshots retain filters, private-field exclusions, quantities and complete pagination", async () => {
  const database = databaseFixture();
  const claims = Array.from({ length: 105 }, (_, index) => ({ claimId: `claim-${index}`, beneficiary: { firstName: "María", lastName: "Peña" }, allocation: { amount: "1500.00", allocationStatus: "CLAIMED" }, schedule: { queueNumber: index + 1, status: "CHECKED_IN", slot: { slotStart: date, slotEnd: date } }, claimStatus: "CLAIMED", createdAt: date, releasedQuantity: 2, releasedAt: date }));
  database.claim.count = async () => claims.length;
  database.claim.findMany = async query => {
    assert.equal(query.where.claimStatus, "CLAIMED");
    assert.equal(query.where.createdAt.gte.toISOString(), "2026-11-16T16:00:00.000Z");
    assert.equal(query.select.beneficiary.select.contactNumber, undefined);
    return claims.slice(query.skip, query.skip + query.take);
  };
  const report = await generateReportSnapshot(reportSnapshotQuerySchema.parse({ type: "CLAIMS", distributionId, status: "CLAIMED", dateFrom: "2026-11-17" }), actor, database);
  assert.equal(report.data.claims.length, 105);
  assert.equal(report.data.claims.at(-1).beneficiaryName, "María Peña");
  assert.equal(report.data.claims[0].allocatedAmount, "1500.00");
  assert.equal(report.data.claims[0].releasedQuantity, 2);
});

test("audit export uses exact applied filters, all rows, deterministic ordering and masking", async () => {
  const records = Array.from({ length: 21 }, (_, auditId) => ({ auditId, details: { password: "private", scope: { authorization: "Bearer private" }, rowCount: 2 } }));
  const result = await getAuditExport({ action: "REPORT_GENERATED", dateFrom: date }, { auditLog: { findMany: async query => {
    assert.equal(query.where.action, "REPORT_GENERATED");
    assert.equal(query.where.createdAt.gte, date);
    assert.equal(query.take, undefined);
    assert.deepEqual(query.orderBy, [{ createdAt: "desc" }, { auditId: "desc" }]);
    return records;
  } } });
  assert.equal(result.total, 21);
  assert.equal(result.auditLogs[0].details.password, "[REDACTED]");
  assert.equal(result.auditLogs[0].details.scope.authorization, "[REDACTED]");
});

test("AI selects only server-authored facts and rejects invented or incomplete highlights", async () => {
  const facts = [{ id: "verified", label: "Awaiting assistance", explanation: "7 verified claims await assistance." }, { id: "completed", label: "Completed", explanation: "18 completed claims." }];
  const client = selected => ({ chat: { completions: { create: async request => {
    assert.equal(request.model, "mistral-large-4-0");
    assert.equal(request.reasoning_effort, "low");
    assert.equal(JSON.stringify(request.messages).includes("beneficiaryName"), false);
    return { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "select_report_highlights", arguments: JSON.stringify({ factIds: selected }) } }] } }] };
  } } } });
  const explained = await explainReportFacts(facts, { client: client(["completed", "verified"]) });
  assert.deepEqual(explained.highlights, [facts[1], facts[0]]);
  await assert.rejects(explainReportFacts(facts, { client: client(["invented"]) }), { code: "REPORT_AI_UNAVAILABLE" });
  await assert.rejects(explainReportFacts(facts, { client: client(["verified", "verified"]) }), { code: "REPORT_AI_UNAVAILABLE" });
  await assert.rejects(explainReportFacts(facts, { apiKey: "" }), { code: "REPORT_AI_UNAVAILABLE" });
});
