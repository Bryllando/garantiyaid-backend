import { randomUUID } from "node:crypto";
import { once } from "node:events";
import bcrypt from "bcrypt";
import app from "../src/app.js";
import prisma from "../src/lib/prisma.js";
import { issueAccessToken } from "../src/modules/auth/auth.service.js";

let server;
let baseUrl;
const temporaryProgramIds = [];
const temporaryBeneficiaryIds = [];
const temporaryEnrollmentIds = [];
const temporaryDistributionIds = [];
const temporaryAllocationIds = [];
const temporarySlotIds = [];
const temporaryScheduleIds = [];
const temporaryClaimIds = [];
const temporaryWalletIds = [];
const temporaryTransactionIds = [];
const temporarySessionIds = [];
const temporaryIdempotencyKeys = [];
const temporaryUserIds = [];

async function verificationAccessToken(user) {
  const session = await issueAccessToken(user, { ipAddress: "127.0.0.1" });
  temporarySessionIds.push(session.sessionId);
  return session.accessToken;
}

async function request(path, {
  method = "GET",
  token,
  body,
  idempotencyKey,
} = {}) {
  if (idempotencyKey) {
    temporaryIdempotencyKeys.push(idempotencyKey);
  }
  const hasBody = body !== undefined;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  return { response, payload };
}

function requireStatus(result, expectedStatus, step) {
  if (result.response.status !== expectedStatus) {
    throw new Error(`${step} returned ${result.response.status}: ${JSON.stringify(result.payload)}`);
  }
}

function requireErrorCode(result, expectedCode, step) {
  if (result.payload.error?.code !== expectedCode) {
    throw new Error(
      `${step} returned error ${result.payload.error?.code}: ${JSON.stringify(result.payload)}`,
    );
  }
}

function futureDate(offsetDays) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

async function unusedDistributionDate(barangayId) {
  for (let offset = 1850; offset <= 1950; offset += 1) {
    const date = futureDate(offset);
    const count = await prisma.distribution.count({
      where: { barangayId, distributionDate: new Date(`${date}T00:00:00.000Z`) },
    });
    if (count === 0) {
      return date;
    }
  }
  throw new Error("Could not find an unused date for wallet verification.");
}

async function cleanup() {
  if (temporaryIdempotencyKeys.length > 0) {
    await prisma.idempotencyRecord.deleteMany({
      where: { idempotencyKey: { in: [...new Set(temporaryIdempotencyKeys)] } },
    });
  }
  const auditRecordIds = [
    ...temporaryWalletIds,
    ...temporaryTransactionIds,
    ...temporaryClaimIds,
    ...temporaryDistributionIds,
  ];
  if (auditRecordIds.length > 0 || temporaryUserIds.length > 0) {
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          ...(auditRecordIds.length > 0 ? [{ recordId: { in: auditRecordIds } }] : []),
          ...(temporaryUserIds.length > 0 ? [{ userId: { in: temporaryUserIds } }] : []),
        ],
      },
    });
  }
  if (temporaryTransactionIds.length > 0) {
    await prisma.transaction.deleteMany({
      where: { transactionId: { in: temporaryTransactionIds } },
    });
  }
  if (temporaryWalletIds.length > 0) {
    await prisma.walletAccount.deleteMany({ where: { walletId: { in: temporaryWalletIds } } });
  }
  if (temporaryClaimIds.length > 0) {
    await prisma.claim.deleteMany({ where: { claimId: { in: temporaryClaimIds } } });
  }
  if (temporaryScheduleIds.length > 0) {
    await prisma.schedule.deleteMany({ where: { scheduleId: { in: temporaryScheduleIds } } });
  }
  if (temporaryAllocationIds.length > 0) {
    await prisma.distributionAllocation.deleteMany({
      where: { allocationId: { in: temporaryAllocationIds } },
    });
  }
  if (temporarySlotIds.length > 0) {
    await prisma.distributionSlot.deleteMany({ where: { slotId: { in: temporarySlotIds } } });
  }
  if (temporaryDistributionIds.length > 0) {
    await prisma.distribution.deleteMany({
      where: { distributionId: { in: temporaryDistributionIds } },
    });
  }
  if (temporaryEnrollmentIds.length > 0) {
    await prisma.enrollment.deleteMany({ where: { enrollmentId: { in: temporaryEnrollmentIds } } });
  }
  if (temporaryBeneficiaryIds.length > 0) {
    await prisma.beneficiary.deleteMany({
      where: { beneficiaryId: { in: temporaryBeneficiaryIds } },
    });
  }
  if (temporaryProgramIds.length > 0) {
    await prisma.program.deleteMany({ where: { programId: { in: temporaryProgramIds } } });
  }
  if (temporarySessionIds.length > 0) {
    await prisma.staffSession.deleteMany({ where: { sessionId: { in: temporarySessionIds } } });
  }
  if (temporaryUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { userId: { in: temporaryUserIds } } });
  }
}

try {
  const suffix = Date.now().toString().slice(-10);
  const [administrator, dswd, existingFacilitator] = await Promise.all([
    prisma.user.findFirst({ where: { role: "SYSTEM_ADMIN", isActive: true } }),
    prisma.user.findFirst({ where: { role: "DSWD_STAFF", isActive: true } }),
    prisma.user.findFirst({
      where: {
        role: "BARANGAY_FACILITATOR",
        isActive: true,
        barangayId: { not: null },
        barangay: { isActive: true },
      },
    }),
  ]);
  if (!administrator || !dswd) {
    throw new Error(
      "Active SYSTEM_ADMIN and DSWD_STAFF accounts are required. Run the initial seed and create an active DSWD staff account first.",
    );
  }
  let facilitator = existingFacilitator;
  if (!facilitator) {
    const barangay = await prisma.barangay.findFirst({ where: { isActive: true } });
    if (!barangay) {
      throw new Error("An active Barangay is required for the temporary verification facilitator.");
    }
    facilitator = await prisma.user.create({
      data: {
        employeeId: `VERIFY-BRGY-${suffix}`,
        username: `verify.brgy.${suffix}`,
        fullName: "Temporary Wallet Verifier",
        email: `verify-wallet-${suffix}@example.invalid`,
        passwordHash: await bcrypt.hash(randomUUID(), 12),
        role: "BARANGAY_FACILITATOR",
        barangayId: barangay.barangayId,
        isActive: true,
      },
    });
    temporaryUserIds.push(facilitator.userId);
  }
  const [adminToken, dswdToken, facilitatorToken] = await Promise.all([
    verificationAccessToken(administrator),
    verificationAccessToken(dswd),
    verificationAccessToken(facilitator),
  ]);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  const program = await prisma.program.create({
    data: {
      programName: `Temporary Simulated Wallet Program ${suffix}`,
      programCode: `WAL-${suffix}`,
      programType: "CASH_ASSISTANCE",
      description: "Temporary wallet verification fixture.",
      grantAmount: 1000,
      budgetAmount: 10000,
      status: "ACTIVE",
      createdById: administrator.userId,
    },
  });
  temporaryProgramIds.push(program.programId);

  const beneficiaries = [];
  for (const [index, firstName] of ["Ledger", "Recipient"].entries()) {
    const beneficiary = await prisma.beneficiary.create({
      data: {
        firstName,
        lastName: `WalletVerify${suffix}`,
        birthDate: new Date(`198${index}-06-01T00:00:00.000Z`),
        sex: index === 0 ? "FEMALE" : "MALE",
        address: "Temporary wallet verification address",
        barangayId: facilitator.barangayId,
        isVerified: true,
        status: "ACTIVE",
      },
    });
    temporaryBeneficiaryIds.push(beneficiary.beneficiaryId);
    beneficiaries.push(beneficiary);
  }

  const enrollment = await prisma.enrollment.create({
    data: {
      beneficiaryId: beneficiaries[0].beneficiaryId,
      programId: program.programId,
      submittedById: facilitator.userId,
      status: "APPROVED",
      reviewedById: dswd.userId,
      reviewedAt: new Date(),
    },
  });
  temporaryEnrollmentIds.push(enrollment.enrollmentId);
  const distributionDate = await unusedDistributionDate(facilitator.barangayId);
  const distribution = await prisma.distribution.create({
    data: {
      programId: program.programId,
      createdById: administrator.userId,
      title: `Temporary Wallet Verification Event ${suffix}`,
      distributionDate: new Date(`${distributionDate}T00:00:00.000Z`),
      startTime: new Date("1970-01-01T08:00:00.000Z"),
      endTime: new Date("1970-01-01T09:00:00.000Z"),
      slotDurationMinutes: 60,
      location: "Temporary Simulated Ledger Hall",
      barangayId: facilitator.barangayId,
      status: "OPEN",
    },
  });
  temporaryDistributionIds.push(distribution.distributionId);
  const slot = await prisma.distributionSlot.create({
    data: {
      distributionId: distribution.distributionId,
      sessionId: randomUUID(),
      sessionLabel: "Wallet verification session",
      location: distribution.location,
      serviceAreas: [],
      slotStart: new Date(`${distributionDate}T00:00:00.000Z`),
      slotEnd: new Date(`${distributionDate}T01:00:00.000Z`),
      capacity: 1,
      slotStatus: "FULL",
    },
  });
  temporarySlotIds.push(slot.slotId);
  const allocation = await prisma.distributionAllocation.create({
    data: {
      distributionId: distribution.distributionId,
      beneficiaryId: beneficiaries[0].beneficiaryId,
      enrollmentId: enrollment.enrollmentId,
      amount: 1000,
      allocationStatus: "ALLOCATED",
      allocatedById: administrator.userId,
      allocatedAt: new Date(),
    },
  });
  temporaryAllocationIds.push(allocation.allocationId);
  const schedule = await prisma.schedule.create({
    data: {
      distributionId: distribution.distributionId,
      beneficiaryId: beneficiaries[0].beneficiaryId,
      slotId: slot.slotId,
      queueNumber: 1,
      status: "CHECKED_IN",
    },
  });
  temporaryScheduleIds.push(schedule.scheduleId);
  const claim = await prisma.claim.create({
    data: {
      beneficiaryId: beneficiaries[0].beneficiaryId,
      distributionId: distribution.distributionId,
      scheduleId: schedule.scheduleId,
      verifiedById: facilitator.userId,
      allocationId: allocation.allocationId,
      claimStatus: "VERIFIED",
      verificationMethod: "QR",
      qrVerified: true,
      biometricVerified: false,
    },
  });
  temporaryClaimIds.push(claim.claimId);

  const walletAbsent = await request(
    `/wallets/beneficiaries/${beneficiaries[1].beneficiaryId}`,
    { token: dswdToken },
  );
  requireStatus(walletAbsent, 200, "beneficiary wallet lookup before creation");
  if (
    walletAbsent.payload.data.beneficiary.beneficiaryId !== beneficiaries[1].beneficiaryId
    || walletAbsent.payload.data.wallet !== null
  ) {
    throw new Error("Beneficiary wallet lookup did not distinguish an absent wallet.");
  }
  const facilitatorWalletLookup = await request(
    `/wallets/beneficiaries/${beneficiaries[1].beneficiaryId}`,
    { token: facilitatorToken },
  );
  requireStatus(facilitatorWalletLookup, 403, "beneficiary wallet lookup restriction");

  const createdRecipientWallet = await request("/wallets", {
    method: "POST",
    token: dswdToken,
    body: { beneficiaryId: beneficiaries[1].beneficiaryId },
  });
  requireStatus(createdRecipientWallet, 201, "explicit simulated wallet creation");
  const recipientWalletId = createdRecipientWallet.payload.data.wallet.walletId;
  temporaryWalletIds.push(recipientWalletId);
  if (
    createdRecipientWallet.payload.data.wallet.balance !== "0"
    || createdRecipientWallet.payload.data.simulation.realFundsMoved !== false
  ) {
    throw new Error("New simulated wallet did not start at zero with an explicit disclosure.");
  }
  const walletReplay = await request("/wallets", {
    method: "POST",
    token: dswdToken,
    body: { beneficiaryId: beneficiaries[1].beneficiaryId },
  });
  requireStatus(walletReplay, 200, "wallet create-by-beneficiary replay");
  if (walletReplay.payload.data.created !== false) {
    throw new Error("Repeated wallet creation did not return the existing wallet.");
  }

  const creditable = await request(
    `/distributions/${distribution.distributionId}/creditable-claims?page=1&pageSize=20`,
    { token: dswdToken },
  );
  requireStatus(creditable, 200, "creditable claim listing");
  if (
    creditable.payload.data.summary.creditableClaimCount !== 1
    || creditable.payload.data.claims[0].claimId !== claim.claimId
  ) {
    throw new Error("Verified claim was not listed as creditable.");
  }

  const missingKey = await request(
    `/distributions/${distribution.distributionId}/claims/${claim.claimId}/credit`,
    { method: "POST", token: dswdToken, body: {} },
  );
  requireStatus(missingKey, 400, "credit idempotency-key requirement");
  requireErrorCode(missingKey, "IDEMPOTENCY_KEY_REQUIRED", "credit idempotency-key requirement");

  const creditKey = randomUUID();
  const credited = await request(
    `/distributions/${distribution.distributionId}/claims/${claim.claimId}/credit`,
    {
      method: "POST",
      token: dswdToken,
      idempotencyKey: creditKey,
      body: { description: "Automated wallet verification credit" },
    },
  );
  requireStatus(credited, 201, "verified claim simulated credit");
  const creditTransaction = credited.payload.data.transaction;
  const sourceWallet = credited.payload.data.wallet;
  temporaryTransactionIds.push(creditTransaction.transactionId);
  temporaryWalletIds.push(sourceWallet.walletId);
  if (
    credited.response.headers.get("idempotency-replayed") !== "false"
    || creditTransaction.transactionType !== "BENEFIT_CREDIT"
    || creditTransaction.status !== "COMPLETED"
    || creditTransaction.amount !== "1000"
    || sourceWallet.balance !== "1000"
    || credited.payload.data.lifecycle.claimStatus !== "CLAIMED"
    || credited.payload.data.lifecycle.allocationStatus !== "CLAIMED"
    || credited.payload.data.simulation.realFundsMoved !== false
  ) {
    throw new Error("Simulated credit did not produce the expected ledger and lifecycle state.");
  }

  const creditReplay = await request(
    `/distributions/${distribution.distributionId}/claims/${claim.claimId}/credit`,
    {
      method: "POST",
      token: dswdToken,
      idempotencyKey: creditKey,
      body: { description: "Automated wallet verification credit" },
    },
  );
  requireStatus(creditReplay, 201, "simulated credit idempotent replay");
  if (
    creditReplay.response.headers.get("idempotency-replayed") !== "true"
    || creditReplay.payload.data.transaction.transactionId !== creditTransaction.transactionId
  ) {
    throw new Error("Simulated credit replay did not return the original transaction.");
  }
  const duplicateCredit = await request(
    `/distributions/${distribution.distributionId}/claims/${claim.claimId}/credit`,
    { method: "POST", token: dswdToken, idempotencyKey: randomUUID(), body: {} },
  );
  requireStatus(duplicateCredit, 409, "one-credit-per-claim protection");
  requireErrorCode(duplicateCredit, "CLAIM_ALREADY_CREDITED", "one-credit-per-claim protection");

  const facilitatorWalletRead = await request(`/wallets/${sourceWallet.walletId}`, {
    token: facilitatorToken,
  });
  requireStatus(facilitatorWalletRead, 403, "Barangay financial-data restriction");
  const walletRead = await request(`/wallets/${sourceWallet.walletId}`, { token: dswdToken });
  requireStatus(walletRead, 200, "DSWD wallet read");

  const invalidTransfer = await request(`/wallets/${sourceWallet.walletId}/transfers`, {
    method: "POST",
    token: dswdToken,
    idempotencyKey: randomUUID(),
    body: { recipientBeneficiaryId: beneficiaries[1].beneficiaryId, amount: 0 },
  });
  requireStatus(invalidTransfer, 400, "invalid simulated transfer amount");
  const insufficientTransfer = await request(`/wallets/${sourceWallet.walletId}/transfers`, {
    method: "POST",
    token: dswdToken,
    idempotencyKey: randomUUID(),
    body: { recipientBeneficiaryId: beneficiaries[1].beneficiaryId, amount: 5000 },
  });
  requireStatus(insufficientTransfer, 409, "insufficient simulated balance protection");
  requireErrorCode(
    insufficientTransfer,
    "INSUFFICIENT_SIMULATED_BALANCE",
    "insufficient simulated balance protection",
  );

  const transferKey = randomUUID();
  const transferred = await request(`/wallets/${sourceWallet.walletId}/transfers`, {
    method: "POST",
    token: dswdToken,
    idempotencyKey: transferKey,
    body: {
      recipientBeneficiaryId: beneficiaries[1].beneficiaryId,
      amount: 400,
      description: "Closed-loop wallet verification transfer",
    },
  });
  requireStatus(transferred, 201, "internal simulated transfer");
  temporaryTransactionIds.push(
    transferred.payload.data.sourceTransaction.transactionId,
    transferred.payload.data.recipientTransaction.transactionId,
  );
  if (
    transferred.payload.data.sourceWallet.balance !== "600"
    || transferred.payload.data.recipientWallet.balance !== "400"
    || transferred.payload.data.sourceTransaction.transactionType !== "SIMULATED_TRANSFER_OUT"
    || transferred.payload.data.recipientTransaction.transactionType !== "SIMULATED_TRANSFER_IN"
    || transferred.payload.data.simulation.externalPaymentRailConnected !== false
  ) {
    throw new Error("Internal transfer did not create balanced closed-loop ledger entries.");
  }
  const transferReplay = await request(`/wallets/${sourceWallet.walletId}/transfers`, {
    method: "POST",
    token: dswdToken,
    idempotencyKey: transferKey,
    body: {
      recipientBeneficiaryId: beneficiaries[1].beneficiaryId,
      amount: 400,
      description: "Closed-loop wallet verification transfer",
    },
  });
  requireStatus(transferReplay, 201, "internal transfer idempotent replay");
  if (transferReplay.response.headers.get("idempotency-replayed") !== "true") {
    throw new Error("Internal transfer replay was not marked as replayed.");
  }

  const [sourceHistory, recipientHistory] = await Promise.all([
    request(`/wallets/${sourceWallet.walletId}/transactions?page=1&pageSize=20`, {
      token: dswdToken,
    }),
    request(`/wallets/${recipientWalletId}/transactions?page=1&pageSize=20`, {
      token: dswdToken,
    }),
  ]);
  requireStatus(sourceHistory, 200, "source wallet history after transfer");
  requireStatus(recipientHistory, 200, "recipient wallet history after transfer");
  const sourceDebit = sourceHistory.payload.data.transactions.find(
    ({ transferGroupId }) => transferGroupId === transferred.payload.data.transferGroupId,
  );
  const recipientCredit = recipientHistory.payload.data.transactions.find(
    ({ transferGroupId }) => transferGroupId === transferred.payload.data.transferGroupId,
  );
  if (
    sourceDebit?.transactionType !== "SIMULATED_TRANSFER_OUT"
    || recipientCredit?.transactionType !== "SIMULATED_TRANSFER_IN"
  ) {
    throw new Error("Individual wallet histories did not expose the matching debit and credit.");
  }

  const prematureReversal = await request(
    `/wallets/${sourceWallet.walletId}/transactions/${creditTransaction.transactionId}/reverse`,
    {
      method: "POST",
      token: adminToken,
      idempotencyKey: randomUUID(),
      body: { reason: "Attempt reversal while transferred balance is outstanding." },
    },
  );
  requireStatus(prematureReversal, 409, "dependent-balance reversal protection");
  requireErrorCode(
    prematureReversal,
    "REVERSAL_INSUFFICIENT_SIMULATED_BALANCE",
    "dependent-balance reversal protection",
  );

  const transferBack = await request(`/wallets/${recipientWalletId}/transfers`, {
    method: "POST",
    token: dswdToken,
    idempotencyKey: randomUUID(),
    body: {
      recipientBeneficiaryId: beneficiaries[0].beneficiaryId,
      amount: 400,
      description: "Return closed-loop test balance before reversal",
    },
  });
  requireStatus(transferBack, 201, "simulated return transfer");
  temporaryTransactionIds.push(
    transferBack.payload.data.sourceTransaction.transactionId,
    transferBack.payload.data.recipientTransaction.transactionId,
  );
  if (
    transferBack.payload.data.sourceWallet.balance !== "0"
    || transferBack.payload.data.recipientWallet.balance !== "1000"
  ) {
    throw new Error("Return transfer did not restore balances before controlled reversal.");
  }

  const receipt = await request(
    `/wallets/${sourceWallet.walletId}/transactions/${creditTransaction.transactionId}/receipt`,
    { token: dswdToken },
  );
  requireStatus(receipt, 200, "simulated transaction receipt");
  if (
    receipt.payload.data.receiptVersion !== "GYA-SIM-1"
    || receipt.payload.data.transaction.referenceNo !== creditTransaction.referenceNo
    || receipt.payload.data.simulation.realFundsMoved !== false
  ) {
    throw new Error("Receipt does not preserve the reference and simulation disclosure.");
  }

  const reversalKey = randomUUID();
  const reversed = await request(
    `/wallets/${sourceWallet.walletId}/transactions/${creditTransaction.transactionId}/reverse`,
    {
      method: "POST",
      token: adminToken,
      idempotencyKey: reversalKey,
      body: { reason: "Controlled verification reversal after balance restoration." },
    },
  );
  requireStatus(reversed, 201, "controlled benefit-credit reversal");
  temporaryTransactionIds.push(reversed.payload.data.reversalTransaction.transactionId);
  if (
    reversed.payload.data.originalTransaction.status !== "REVERSED"
    || reversed.payload.data.reversalTransaction.transactionType !== "BENEFIT_REVERSAL"
    || reversed.payload.data.wallet.balance !== "0"
    || reversed.payload.data.lifecycle.claimStatus !== "VOIDED"
    || reversed.payload.data.lifecycle.allocationStatus !== "CLAIMED"
  ) {
    throw new Error("Controlled reversal did not preserve the required ledger lifecycle.");
  }
  const reversalReplay = await request(
    `/wallets/${sourceWallet.walletId}/transactions/${creditTransaction.transactionId}/reverse`,
    {
      method: "POST",
      token: adminToken,
      idempotencyKey: reversalKey,
      body: { reason: "Controlled verification reversal after balance restoration." },
    },
  );
  requireStatus(reversalReplay, 201, "reversal idempotent replay");
  if (reversalReplay.response.headers.get("idempotency-replayed") !== "true") {
    throw new Error("Controlled reversal replay was not marked as replayed.");
  }

  const transactions = await request(
    `/distributions/${distribution.distributionId}/transactions?page=1&pageSize=20`,
    { token: dswdToken },
  );
  requireStatus(transactions, 200, "distribution transaction monitoring");
  if (transactions.payload.data.summary.matchingTransactionCount !== 2) {
    throw new Error("Distribution ledger should contain the credit and its reversal only.");
  }
  const serializedTransactions = JSON.stringify(transactions.payload);
  for (const forbiddenField of ["passwordHash", "totpSecret", "bankAccountNumber", "externalPaymentToken"]) {
    if (serializedTransactions.includes(forbiddenField)) {
      throw new Error(`Transaction response exposed forbidden field ${forbiddenField}.`);
    }
  }

  const reconciliation = await request(
    `/distributions/${distribution.distributionId}/reconciliation`,
    { token: dswdToken },
  );
  requireStatus(reconciliation, 200, "distribution reconciliation");
  const summary = reconciliation.payload.data.reconciliation;
  if (
    summary.grossCreditedAmount !== "1000.00"
    || summary.reversedAmount !== "1000.00"
    || summary.netCreditedAmount !== "0.00"
    || summary.expectedClaimedAmount !== "0.00"
    || summary.ledgerBalanced !== true
    || summary.readyToClose !== true
    || summary.exceptions.length !== 0
  ) {
    throw new Error(`Distribution reconciliation is not balanced: ${JSON.stringify(summary)}`);
  }

  const auditActions = await prisma.auditLog.findMany({
    where: { recordId: { in: temporaryTransactionIds } },
    select: { action: true },
  });
  const actions = new Set(auditActions.map((row) => row.action));
  for (const action of [
    "SIMULATED_BENEFIT_CREDIT_COMPLETED",
    "SIMULATED_INTERNAL_TRANSFER_COMPLETED",
    "SIMULATED_BENEFIT_CREDIT_REVERSED",
  ]) {
    if (!actions.has(action)) {
      throw new Error(`Missing wallet audit action ${action}.`);
    }
  }

  console.log("Simulated wallet and benefit transaction verification passed.");
  console.log("Verified wallet creation, one-time credit, idempotent replay, role restrictions,");
  console.log("closed-loop transfers, balance controls, receipts, reversal, reconciliation, audits,");
  console.log("and explicit no-real-funds/no-external-payment-rail disclosures.");
} finally {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await cleanup();
  await prisma.$disconnect();
}
