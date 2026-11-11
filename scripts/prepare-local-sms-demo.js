import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../src/lib/prisma.js";
import { env } from "../src/config/env.js";
import { buildDistributionSlotRows } from "../src/modules/distributions/distributionSlot.service.js";
import { allocationGrantAmount, assertRequestedEnrollmentsEligible } from "../src/modules/distributions/distributionAllocation.service.js";
import { assistantReminderPreviewFromSchedules, notificationScheduleContextSelect } from "../src/modules/notifications/notification.service.js";

// Synthetic local fixtures only; never use this in place of a real enrollment review.
const distributionId = process.argv.find((value) => value.startsWith("--distribution-id="))?.split("=")[1];
const source = "LOCAL_SMS_DEMO_FIXTURE";
const demoNote = "DEMO ONLY: synthetic SMS test data, not verified identity or an approval for actual assistance.";
const messageTemplate = "TEST ONLY - GarantiyAid SMS demo for {beneficiary}. This is a test message, not a real aid schedule or claim authorization.";

try {
  assert.ok(process.argv.includes("--apply"), "Use --apply to prepare the local demo. This script never queues SMS.");
  assert.match(distributionId ?? "", /^[a-f0-9-]{36}$/i, "Supply --distribution-id=<demo event UUID>.");
  assert.notEqual(env.nodeEnv, "production", "Demo preparation refuses production mode.");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(env.databaseUrl).hostname), "Demo preparation requires local PostgreSQL.");

  const result = await prisma.$transaction(async (tx) => {
    const event = await tx.distribution.findUniqueOrThrow({ where: { distributionId } });
    assert.equal(event.title, "TEST SMS Notification Demo", "Only the explicitly named SMS demo event may be prepared.");
    assert.equal(event.status, "DRAFT", "Leave operational events unchanged.");
    assert.equal(await tx.claim.count({ where: { distributionId } }), 0, "The demo must have no claims.");
    const beneficiaries = await tx.beneficiary.findMany({
      where: { firstName: "SMS Demo", lastName: { in: ["Alpha", "Beta"] }, barangayId: event.barangayId },
      orderBy: { lastName: "asc" },
    });
    assert.equal(beneficiaries.length, 2, "Create exactly the requested Alpha and Beta demo beneficiaries first.");
    for (const person of beneficiaries) {
      assert.ok(person.address.startsWith("DEMO ONLY - SMS notification testing"), "Never seed approvals for a real identity.");
      assert.equal(person.status, "ACTIVE");
      assert.equal(person.passwordHash, null, "This setup must not modify mobile accounts.");
    }
    const existingSetup = await tx.auditLog.findFirst({ where: { action: "LOCAL_SMS_DEMO_PREPARED", recordId: distributionId } });
    if (existingSetup) return { alreadyPrepared: true, originalProgramId: existingSetup.details.originalProgramId };

    for (const model of [tx.distributionSlot, tx.distributionAllocation, tx.schedule, tx.notification, tx.qrToken]) {
      assert.equal(await model.count({ where: { distributionId } }), 0, "Refusing to overwrite existing event work.");
    }
    assert.equal(await tx.program.count({ where: { programCode: "TEST-SMS-DEMO" } }), 0, "Demo program already exists; inspect it before preparing another event.");
    assert.equal(await tx.user.count({ where: { employeeId: "DEMO-SMS-FIXTURE" } }), 0, "Demo fixture owner already exists.");
    const fixtureOwner = await tx.user.create({ data: {
      employeeId: "DEMO-SMS-FIXTURE", fullName: "SMS demo data setup (disabled)",
      email: "sms-demo-fixture@example.invalid", role: "DSWD_STAFF", isActive: false,
      passwordHash: `disabled-demo-${randomUUID()}`,
    } });
    const program = await tx.program.create({ data: {
      programCode: "TEST-SMS-DEMO", programName: "TEST ONLY - SMS notification demo",
      programType: "SMS_DEMO", status: "ACTIVE", description: `${demoNote} The PHP 1 grant and PHP 2 budget are fixture values only. No real disbursement.`,
      grantAmount: "1", budgetAmount: "2", requiredDocumentTypes: [], createdById: fixtureOwner.userId,
    } });
    await tx.distribution.update({ where: { distributionId }, data: { programId: program.programId } });
    const slots = buildDistributionSlotRows(event, [{
      label: "TEST ONLY - SMS demo session", date: event.distributionDate,
      startTime: event.startTime, endTime: event.endTime, location: event.location,
      capacity: 2, serviceAreas: [],
    }]);
    assert.ok(slots.length > 0 && slots[0].slotStart > new Date(), "Choose a future demo session first.");
    assert.equal(await tx.distributionSlot.count({ where: {
      distributionId: { not: distributionId }, distribution: { barangayId: event.barangayId, status: { not: "CANCELLED" } },
      slotStart: { lt: slots.at(-1).slotEnd }, slotEnd: { gt: slots[0].slotStart },
    } }), 0, "The demo session overlaps another event.");
    await tx.distributionSlot.createMany({ data: slots });
    const firstSlot = await tx.distributionSlot.findFirstOrThrow({ where: { distributionId }, orderBy: { slotStart: "asc" } });
    for (const [index, person] of beneficiaries.entries()) {
      const enrollment = await tx.enrollment.create({ data: {
        beneficiaryId: person.beneficiaryId, programId: program.programId, submittedById: fixtureOwner.userId,
        status: "APPROVED", reviewNotes: demoNote, eligibilitySnapshot: { source, demoOnly: true, identityVerified: false },
      } });
      assertRequestedEnrollmentsEligible([{ ...enrollment, beneficiary: person }], [enrollment.enrollmentId], { ...event, programId: program.programId, slots });
      await tx.distributionAllocation.create({ data: {
        distributionId, beneficiaryId: person.beneficiaryId, enrollmentId: enrollment.enrollmentId,
        amount: allocationGrantAmount(program), allocationStatus: "ALLOCATED", allocatedById: fixtureOwner.userId, allocatedAt: new Date(),
      } });
      await tx.schedule.create({ data: {
        distributionId, beneficiaryId: person.beneficiaryId, slotId: firstSlot.slotId, queueNumber: index + 1, status: "SCHEDULED", assignedByAi: false,
      } });
    }
    await tx.distributionSlot.update({ where: { slotId: firstSlot.slotId }, data: { slotStatus: "FULL" } });
    await tx.auditLog.create({ data: {
      actorType: "SYSTEM", userId: null, action: "LOCAL_SMS_DEMO_PREPARED", entityAffected: "DISTRIBUTION", recordId: distributionId,
      details: { source, demoOnly: true, originalProgramId: event.programId, programId: program.programId, fixtureOwnerId: fixtureOwner.userId,
        beneficiaryIds: beneficiaries.map((person) => person.beneficiaryId), note: demoNote, notificationQueued: false, realSmsSent: false },
    } });
    return { alreadyPrepared: false, originalProgramId: event.programId };
  }, { isolationLevel: "Serializable", timeout: 20_000 });

  const schedules = await prisma.schedule.findMany({ where: { distributionId, status: "SCHEDULED" }, select: notificationScheduleContextSelect, orderBy: { queueNumber: "asc" } });
  assert.equal(schedules.length, 2);
  assert.ok(schedules.every((row) => row.beneficiary.firstName === "SMS Demo"));
  const preview = assistantReminderPreviewFromSchedules(schedules, { messageTemplate, initiatedById: null });
  assert.equal(preview.recipientCount, 2);
  assert.equal(preview.excludedCount, 0);
  assert.equal(await prisma.claim.count({ where: { distributionId } }), 0);
  console.log(JSON.stringify({ ...result, distributionId, smsProviderMode: env.smsProviderMode, messageTemplate,
    recipientCount: preview.recipientCount, excludedCount: preview.excludedCount,
    recipients: preview.recipients.map(({ beneficiaryName, recipientMasked, queueNumber, slotStart, message }) => ({ beneficiaryName, recipientMasked, queueNumber, slotStart, message })),
    eventOpened: false, notificationsQueuedByScript: 0, realSmsSentByScript: false,
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
