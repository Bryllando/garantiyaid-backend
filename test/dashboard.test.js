import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { io as createSocketClient } from "socket.io-client";
import app from "../src/app.js";
import dashboardRoutes from "../src/modules/dashboard/dashboard.routes.js";
import reportRoutes from "../src/modules/reports/report.routes.js";
import {
  DETAILED_REPORT_ROLES,
  assertDetailedReportAllowed,
  canViewGlobalFinancialMetrics,
  resolveDashboardBarangay,
} from "../src/modules/dashboard/dashboard.policy.js";
import {
  anomalyQuerySchema,
  dashboardDistributionParamsSchema,
  dashboardOverviewQuerySchema,
  fundUtilizationQuerySchema,
} from "../src/modules/dashboard/dashboard.schemas.js";
import {
  calculateFundUtilization,
  decimalToCents,
  formatMoney,
  getDashboardOverview,
  getDistributionAnomalies,
  getDistributionDashboardSummary,
} from "../src/modules/dashboard/dashboard.service.js";
import {
  createCsv,
  protectCsvValue,
  safeDistributionExportFilename,
} from "../src/modules/reports/csv.service.js";
import {
  DISTRIBUTION_EXPORT_COLUMNS,
} from "../src/modules/reports/report.service.js";
import {
  applyCsvDownloadHeaders,
  buildReportAuditLog,
} from "../src/modules/reports/report.controller.js";
import { signAccessToken } from "../src/modules/auth/auth.service.js";
import {
  attachRealtimeServer,
  authenticateSocketConnection,
  clearRealtimePublisher,
  publishRealtimeEvent,
  realtimeRoomsForStaff,
  sanitizeRealtimePayload,
} from "../src/realtime/socket.js";

const distributionId = "11111111-1111-4111-8111-111111111111";
const barangayA = "22222222-2222-4222-8222-222222222222";
const barangayB = "33333333-3333-4333-8333-333333333333";
const programId = "44444444-4444-4444-8444-444444444444";

function routeSurface(router) {
  return router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({ path: layer.route.path, methods: Object.keys(layer.route.methods) }));
}

function group(field, value, count, sum = undefined) {
  return {
    [field]: value,
    _count: { _all: count },
    ...(sum === undefined ? {} : { _sum: { amount: { toString: () => sum } } }),
  };
}

function distributionRecord() {
  return {
    distributionId,
    programId,
    createdById: "55555555-5555-4555-8555-555555555555",
    title: "Phase 8 Distribution",
    distributionDate: new Date("2026-08-20T00:00:00.000Z"),
    startTime: new Date("1970-01-01T08:00:00.000Z"),
    endTime: new Date("1970-01-01T10:00:00.000Z"),
    slotDurationMinutes: 30,
    location: "Barangay Hall",
    barangayId: barangayA,
    status: "OPEN",
    verificationRequirement: "QR_AND_BIOMETRIC",
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
    updatedAt: new Date("2026-08-13T00:00:00.000Z"),
    program: {
      programId,
      programName: "Emergency Aid",
      programCode: "EA-1",
      programType: "CASH",
      status: "ACTIVE",
    },
    barangay: {
      barangayId: barangayA,
      barangayCode: "BRGY-A",
      barangayName: "Barangay A",
      city: "Cebu City",
      province: "Cebu",
      isActive: true,
    },
    createdBy: {
      userId: "55555555-5555-4555-8555-555555555555",
      employeeId: "ADMIN-1",
      username: "admin",
      fullName: "Admin User",
      role: "SYSTEM_ADMIN",
    },
  };
}

test("Phase 8 route surface exposes every dashboard, report, fund, and CSV endpoint", () => {
  assert.deepEqual(routeSurface(dashboardRoutes), [
    { path: "/overview", methods: ["get"] },
    { path: "/distributions/:distributionId/anomalies", methods: ["get"] },
    { path: "/distributions/:distributionId", methods: ["get"] },
  ]);
  assert.deepEqual(routeSurface(reportRoutes), [
    { path: "/distributions/:distributionId/summary", methods: ["get"] },
    { path: "/distributions/:distributionId/claims", methods: ["get"] },
    { path: "/distributions/:distributionId/schedules", methods: ["get"] },
    { path: "/distributions/:distributionId/anomalies", methods: ["get"] },
    { path: "/distributions/:distributionId/export.csv", methods: ["get"] },
    { path: "/fund-utilization", methods: ["get"] },
  ]);
});

test("Phase 8 validation rejects malformed UUIDs and dates while normalizing safe filters", () => {
  const overview = dashboardOverviewQuerySchema.parse({
    programId,
    barangayId: barangayA,
    status: " open ",
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
  });
  assert.equal(overview.status, "OPEN");
  assert.equal(overview.dateFrom.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(dashboardDistributionParamsSchema.safeParse({ distributionId: "bad" }).success, false);
  assert.equal(dashboardOverviewQuerySchema.safeParse({ dateFrom: "2026-09-01", dateTo: "2026-08-01" }).success, false);
  assert.equal(anomalyQuerySchema.safeParse({ dateFrom: "not-a-date" }).success, false);
  assert.equal(fundUtilizationQuerySchema.safeParse({ pageSize: 101 }).success, false);
});

test("facilitators are Barangay-scoped and cannot access detailed or global financial reports", () => {
  const facilitator = { role: "BARANGAY_FACILITATOR", barangayId: barangayA };
  assert.equal(resolveDashboardBarangay(facilitator), barangayA);
  assert.equal(resolveDashboardBarangay(facilitator, barangayA), barangayA);
  assert.throws(
    () => resolveDashboardBarangay(facilitator, barangayB),
    (error) => error.statusCode === 403 && error.code === "FORBIDDEN",
  );
  assert.throws(
    () => assertDetailedReportAllowed(facilitator),
    (error) => error.statusCode === 403 && error.code === "FORBIDDEN",
  );
  assert.deepEqual(DETAILED_REPORT_ROLES, ["SYSTEM_ADMIN", "DSWD_STAFF"]);
  assert.doesNotThrow(() => assertDetailedReportAllowed({ role: "SYSTEM_ADMIN" }));
  assert.doesNotThrow(() => assertDetailedReportAllowed({ role: "DSWD_STAFF" }));
  assert.equal(canViewGlobalFinancialMetrics(facilitator), false);
  assert.equal(canViewGlobalFinancialMetrics({ role: "DSWD_STAFF" }), true);
});

test("dashboard and report HTTP endpoints reject unauthenticated requests", async () => {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of [
      "/api/v1/dashboard/overview",
      `/api/v1/dashboard/distributions/${distributionId}`,
      `/api/v1/reports/distributions/${distributionId}/summary`,
      "/api/v1/reports/fund-utilization",
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      const body = await response.json();
      assert.equal(response.status, 401);
      assert.equal(body.error.code, "AUTHENTICATION_REQUIRED");
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("decimal-safe simulated fund utilization handles reversals without floating-point drift", () => {
  const allocations = [
    group("allocationStatus", "ALLOCATED", 2, "200.20"),
    group("allocationStatus", "CLAIMED", 1, "100.10"),
    group("allocationStatus", "CANCELLED", 1, "50.05"),
  ];
  const transactions = [
    { ...group("status", "COMPLETED", 1, "100.10"), transactionType: "BENEFIT_CREDIT" },
    { ...group("status", "REVERSED", 1, "50.05"), transactionType: "BENEFIT_CREDIT" },
    { ...group("status", "COMPLETED", 1, "50.05"), transactionType: "BENEFIT_REVERSAL" },
    { ...group("status", "FAILED", 1, "10.01"), transactionType: "BENEFIT_CREDIT" },
  ];
  assert.equal(decimalToCents("0.10") + decimalToCents("0.20"), 30n);
  assert.equal(formatMoney(30n), "0.30");
  assert.deepEqual(calculateFundUtilization(allocations, transactions), {
    currency: "PHP",
    allocatedAmount: "300.30",
    grossCreditedAmount: "150.15",
    completedAmount: "100.10",
    reversedAmount: "50.05",
    failedAmount: "10.01",
    netCreditedAmount: "100.10",
    remainingAmount: "200.20",
    simulated: true,
    realFundsMoved: false,
  });
});

test("per-distribution aggregation reports slots, completion, anomalies, QR expiry, and simulated funds", async () => {
  const database = {
    distribution: { findFirst: async () => distributionRecord() },
    distributionSlot: {
      groupBy: async () => [
        { slotStatus: "AVAILABLE", _count: { _all: 2 }, _sum: { capacity: 20 } },
        { slotStatus: "FULL", _count: { _all: 1 }, _sum: { capacity: 10 } },
      ],
    },
    distributionAllocation: {
      groupBy: async () => [
        group("allocationStatus", "ALLOCATED", 3, "300.10"),
        group("allocationStatus", "CLAIMED", 2, "200.20"),
        group("allocationStatus", "CANCELLED", 1, "50.00"),
      ],
    },
    schedule: {
      groupBy: async () => [
        group("status", "SCHEDULED", 2),
        group("status", "CHECKED_IN", 2),
        group("status", "CANCELLED", 1),
      ],
    },
    claim: {
      groupBy: async () => [group("claimStatus", "VERIFIED", 1), group("claimStatus", "CLAIMED", 2)],
    },
    qrToken: {
      groupBy: async () => [group("qrStatus", "ACTIVE", 3), group("qrStatus", "USED", 2), group("qrStatus", "EXPIRED", 1)],
      count: async () => 1,
    },
    qrScanLog: {
      groupBy: async () => [group("scanResult", "VERIFIED", 1), group("scanResult", "PENDING_BIOMETRIC", 1), group("scanResult", "DUPLICATE", 2), group("scanResult", "INVALID_TOKEN", 3)],
    },
    biometricVerificationAttempt: {
      groupBy: async () => [group("result", "MATCHED", 2), group("result", "NO_MATCH", 1), group("result", "LIVENESS_FAILED", 1), group("result", "DUPLICATE", 1)],
    },
    transaction: {
      groupBy: async () => [
        { ...group("status", "COMPLETED", 1, "100.10"), transactionType: "BENEFIT_CREDIT" },
        { ...group("status", "REVERSED", 1, "100.10"), transactionType: "BENEFIT_CREDIT" },
        { ...group("status", "COMPLETED", 1, "100.10"), transactionType: "BENEFIT_REVERSAL" },
        { ...group("status", "FAILED", 1, "25.00"), transactionType: "BENEFIT_CREDIT" },
      ],
    },
  };
  const summary = await getDistributionDashboardSummary(
    distributionId,
    { role: "SYSTEM_ADMIN" },
    database,
    new Date("2026-08-13T00:00:00.000Z"),
  );
  assert.equal(summary.slots.slotCount, 3);
  assert.equal(summary.slots.totalCapacity, 30);
  assert.equal(summary.beneficiaries.claimCompletionPercentage, "40.00");
  assert.equal(summary.qrTokens.activeCount, 2);
  assert.equal(summary.qrTokens.expiredCount, 2);
  assert.equal(summary.qrScans.verifiedCount, 2);
  assert.equal(summary.qrScans.duplicateCount, 2);
  assert.equal(summary.qrScans.invalidCount, 3);
  assert.equal(summary.biometrics.noMatchCount, 1);
  assert.equal(summary.fundUtilization.allocatedAmount, "500.30");
  assert.equal(summary.fundUtilization.netCreditedAmount, "100.10");
  assert.equal(summary.fundUtilization.remainingAmount, "400.20");
  assert.equal(summary.fundUtilization.realFundsMoved, false);
  assert.equal(JSON.stringify(summary).includes('"tokenHash":'), false);
  assert.equal(JSON.stringify(summary).includes('"faceEmbedding":'), false);
});

test("empty overview and empty anomaly monitoring return zeroed, paginated results", async () => {
  const emptyDatabase = {
    program: { count: async () => 0 },
    enrollment: { count: async () => 0, findMany: async () => [] },
    distribution: {
      groupBy: async () => [],
      count: async () => 0,
      findFirst: async () => distributionRecord(),
    },
    distributionAllocation: { groupBy: async () => [] },
    schedule: { groupBy: async () => [] },
    claim: {
      groupBy: async () => [],
      count: async () => 0,
      findMany: async () => [],
    },
    distributionSlot: { aggregate: async () => ({ _count: { _all: 0 }, _sum: { capacity: null } }) },
    qrScanLog: { groupBy: async () => [], findMany: async () => [], count: async () => 0 },
    biometricVerificationAttempt: { groupBy: async () => [], findMany: async () => [], count: async () => 0 },
    transaction: { groupBy: async () => [], findMany: async () => [], count: async () => 0 },
  };
  const overview = await getDashboardOverview({}, { role: "SYSTEM_ADMIN" }, emptyDatabase);
  assert.equal(overview.distributions.totalMatchingDistributionCount, 0);
  assert.equal(overview.beneficiaries.claimCompletionPercentage, "0.00");
  assert.equal(overview.queue.capacityUtilizationPercentage, "0.00");
  assert.equal(overview.fundUtilization.remainingAmount, "0.00");
  const anomalies = await getDistributionAnomalies(
    distributionId,
    { role: "SYSTEM_ADMIN" },
    { page: 1, pageSize: 20 },
    emptyDatabase,
  );
  assert.deepEqual(anomalies.anomalies, []);
  assert.deepEqual(anomalies.pagination, { page: 1, pageSize: 20, total: 0, totalPages: 0 });
});

test("CSV export has stable columns, formula-injection protection, safe filenames, and header-only empty output", () => {
  assert.equal(protectCsvValue("=2+3"), "'=2+3");
  assert.equal(protectCsvValue("  @SUM(A1:A2)"), "'  @SUM(A1:A2)");
  const headers = [{ key: "name", label: "name" }, { key: "amount", label: "amount" }];
  const csv = createCsv(headers, [{ name: "=HYPERLINK(\"bad\")", amount: "100.00" }]);
  assert.equal(csv.split("\r\n")[0], '"name","amount"');
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.equal(createCsv(headers, []), '"name","amount"\r\n');
  assert.equal(DISTRIBUTION_EXPORT_COLUMNS[0].key, "report_version");
  assert.equal(DISTRIBUTION_EXPORT_COLUMNS.at(-1).key, "real_funds_moved");
  assert.equal(DISTRIBUTION_EXPORT_COLUMNS.some(({ key }) => /token|hash|embedding|password|totp/i.test(key)), false);
  assert.equal(safeDistributionExportFilename(distributionRecord()), `garantiyaid-distribution-2026-08-20-${distributionId}.csv`);
});

test("CSV download headers and report audit records explicitly identify prototype, non-COA output", () => {
  const headers = new Map();
  const response = { set: (name, value) => headers.set(name.toLowerCase(), value) };
  const filename = `garantiyaid-distribution-2026-08-20-${distributionId}.csv`;
  applyCsvDownloadHeaders(response, filename);
  assert.equal(headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(headers.get("content-disposition"), `attachment; filename="${filename}"`);
  assert.equal(headers.get("x-report-prototype"), "true");
  assert.equal(headers.get("x-coa-certified"), "false");
  const audit = buildReportAuditLog(
    { auth: { userId: programId }, ip: "127.0.0.1" },
    {
      action: "DISTRIBUTION_COMPLIANCE_CSV_EXPORTED",
      reportType: "DISTRIBUTION_COMPLIANCE",
      distributionId,
      format: "CSV",
      rowCount: 0,
    },
  );
  assert.equal(audit.action, "DISTRIBUTION_COMPLIANCE_CSV_EXPORTED");
  assert.equal(audit.recordId, distributionId);
  assert.equal(audit.details.rowCount, 0);
  assert.equal(audit.details.coaCertified, false);
  assert.equal(Object.hasOwn(audit.details, "csvContents"), false);
});

test("Socket authentication validates the existing JWT session and derives strict role rooms", async () => {
  const userId = "66666666-6666-4666-8666-666666666666";
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const token = signAccessToken({ userId, role: "BARANGAY_FACILITATOR" }, { jwtId: sessionId });
  const database = {
    user: { findUnique: async () => ({ userId, role: "BARANGAY_FACILITATOR", barangayId: barangayA, isActive: true }) },
    staffSession: { findFirst: async () => ({ sessionId }) },
  };
  const user = await authenticateSocketConnection({ handshake: { auth: { accessToken: token }, headers: {} } }, database);
  assert.deepEqual(realtimeRoomsForStaff(user), [`barangay:${barangayA}`]);
  assert.deepEqual(realtimeRoomsForStaff({ role: "SYSTEM_ADMIN" }), ["role:SYSTEM_ADMIN"]);
  await assert.rejects(
    () => authenticateSocketConnection({ handshake: { auth: {}, headers: {} } }, database),
    (error) => error.data.code === "AUTHENTICATION_REQUIRED",
  );
});

function eventWithin(socket, eventName, timeoutMs = 300) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(eventName, onEvent);
      resolve(null);
    }, timeoutMs);
    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(eventName, onEvent);
  });
}

test("Socket rooms isolate Barangays, sanitize payloads, and reject client-published trusted events", async () => {
  const httpServer = createServer(app);
  const users = {
    admin: { userId: programId, role: "SYSTEM_ADMIN", barangayId: null, isActive: true },
    a: { userId: distributionId, role: "BARANGAY_FACILITATOR", barangayId: barangayA, isActive: true },
    b: { userId: barangayB, role: "BARANGAY_FACILITATOR", barangayId: barangayB, isActive: true },
  };
  const io = attachRealtimeServer(httpServer, {
    authenticate: async (socket) => {
      const user = users[socket.handshake.auth?.accessToken];
      if (!user) {
        const error = new Error("unauthorized");
        error.data = { code: "INVALID_TOKEN" };
        throw error;
      }
      return user;
    },
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  const options = (accessToken) => ({
    auth: { accessToken },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  const bad = createSocketClient(url, options("bad"));
  const badError = await once(bad, "connect_error");
  assert.equal(badError[0].data.code, "INVALID_TOKEN");
  bad.close();

  const admin = createSocketClient(url, options("admin"));
  const facilitatorA = createSocketClient(url, options("a"));
  const facilitatorB = createSocketClient(url, options("b"));
  try {
    await Promise.all([once(admin, "connect"), once(facilitatorA, "connect"), once(facilitatorB, "connect")]);
    const adminEvent = eventWithin(admin, "claim.updated");
    const barangayAEvent = eventWithin(facilitatorA, "claim.updated");
    const barangayBEvent = eventWithin(facilitatorB, "claim.updated");
    await publishRealtimeEvent("claim.updated", {
      distributionId,
      barangayId: barangayA,
      data: {
        claimId: programId,
        claimStatus: "VERIFIED",
        rawToken: "do-not-send",
        tokenHash: "do-not-send",
        faceEmbedding: [0.1, 0.2],
        contactNumber: "09170000000",
      },
    });
    const [receivedByAdmin, receivedByA, receivedByB] = await Promise.all([
      adminEvent,
      barangayAEvent,
      barangayBEvent,
    ]);
    assert.equal(receivedByAdmin.data.claimStatus, "VERIFIED");
    assert.equal(receivedByA.data.claimStatus, "VERIFIED");
    assert.equal(receivedByB, null);
    assert.equal(Object.hasOwn(receivedByAdmin.data, "rawToken"), false);
    assert.equal(Object.hasOwn(receivedByAdmin.data, "tokenHash"), false);
    assert.equal(Object.hasOwn(receivedByAdmin.data, "faceEmbedding"), false);
    assert.equal(Object.hasOwn(receivedByAdmin.data, "contactNumber"), false);

    const adminNotificationEvent = eventWithin(admin, "notification.sent");
    const barangayANotificationEvent = eventWithin(facilitatorA, "notification.sent");
    const barangayBNotificationEvent = eventWithin(facilitatorB, "notification.sent");
    await publishRealtimeEvent("notification.sent", {
      distributionId,
      barangayId: barangayA,
      data: {
        notificationId: programId,
        status: "SENT",
        message: "do-not-send",
        recipient: "09170000000",
      },
    });
    const [adminNotification, barangayANotification, barangayBNotification] = await Promise.all([
      adminNotificationEvent,
      barangayANotificationEvent,
      barangayBNotificationEvent,
    ]);
    assert.equal(adminNotification.data.status, "SENT");
    assert.equal(barangayANotification.data.status, "SENT");
    assert.equal(barangayBNotification, null);
    assert.equal(Object.hasOwn(adminNotification.data, "message"), false);
    assert.equal(Object.hasOwn(adminNotification.data, "recipient"), false);

    const adminChatbotEvent = eventWithin(admin, "chatbot.session.escalated");
    const barangayAChatbotEvent = eventWithin(facilitatorA, "chatbot.session.escalated");
    const barangayBChatbotEvent = eventWithin(facilitatorB, "chatbot.session.escalated");
    await publishRealtimeEvent("chatbot.session.escalated", {
      barangayId: barangayA,
      data: {
        sessionId: programId,
        status: "ESCALATED",
        messageText: "do-not-send",
        accessToken: "do-not-send",
      },
    });
    const [adminChatbot, barangayAChatbot, barangayBChatbot] = await Promise.all([
      adminChatbotEvent,
      barangayAChatbotEvent,
      barangayBChatbotEvent,
    ]);
    assert.equal(adminChatbot.data.status, "ESCALATED");
    assert.equal(barangayAChatbot.data.status, "ESCALATED");
    assert.equal(barangayBChatbot, null);
    assert.equal(Object.hasOwn(adminChatbot.data, "messageText"), false);
    assert.equal(Object.hasOwn(adminChatbot.data, "accessToken"), false);

    const adminGenericChatbotEvent = eventWithin(admin, "chatbot.session.escalated");
    const facilitatorGenericChatbotEvent = eventWithin(facilitatorA, "chatbot.session.escalated");
    await publishRealtimeEvent("chatbot.session.escalated", {
      data: { sessionId: programId, status: "ESCALATED" },
    });
    assert.equal((await adminGenericChatbotEvent).data.status, "ESCALATED");
    assert.equal(await facilitatorGenericChatbotEvent, null);

    const adminWalletEvent = eventWithin(admin, "wallet.transaction.completed");
    const facilitatorWalletEvent = eventWithin(facilitatorA, "wallet.transaction.completed");
    await publishRealtimeEvent("wallet.transaction.completed", {
      distributionId,
      barangayId: barangayA,
      data: { amount: "100.00", simulated: true, realFundsMoved: false },
    });
    assert.equal((await adminWalletEvent).data.amount, "100.00");
    assert.equal(await facilitatorWalletEvent, null);

    const clientError = eventWithin(facilitatorA, "realtime.error");
    const illicitBroadcast = eventWithin(admin, "wallet.transaction.completed", 200);
    facilitatorA.emit("wallet.transaction.completed", { realFundsMoved: true });
    assert.equal((await clientError).code, "CLIENT_EVENT_PUBLICATION_FORBIDDEN");
    assert.equal(await illicitBroadcast, null);

    const notificationClientError = eventWithin(facilitatorA, "realtime.error");
    const illicitNotification = eventWithin(admin, "notification.sent", 200);
    facilitatorA.emit("notification.sent", { status: "SENT" });
    assert.equal((await notificationClientError).code, "CLIENT_EVENT_PUBLICATION_FORBIDDEN");
    assert.equal(await illicitNotification, null);

    const chatbotClientError = eventWithin(facilitatorA, "realtime.error");
    const illicitChatbot = eventWithin(admin, "chatbot.session.resolved", 200);
    facilitatorA.emit("chatbot.session.resolved", { status: "RESOLVED" });
    assert.equal((await chatbotClientError).code, "CLIENT_EVENT_PUBLICATION_FORBIDDEN");
    assert.equal(await illicitChatbot, null);
  } finally {
    admin.close();
    facilitatorA.close();
    facilitatorB.close();
    clearRealtimePublisher(io);
    await new Promise((resolve) => io.close(resolve));
    if (httpServer.listening) {
      await new Promise((resolve) => httpServer.close(resolve));
    }
  }
});

test("realtime sanitizer recursively excludes credentials, raw QR data, and biometric templates", () => {
  const safe = sanitizeRealtimePayload({
    claimId: distributionId,
    nested: {
      accessToken: "secret",
      passwordHash: "secret",
      totpSecret: "secret",
      qrTokenHash: "secret",
      faceCapture: "secret",
      realFundsMoved: true,
      status: "VERIFIED",
    },
  });
  assert.deepEqual(safe, {
    claimId: distributionId,
    nested: { realFundsMoved: false, status: "VERIFIED" },
  });
});
