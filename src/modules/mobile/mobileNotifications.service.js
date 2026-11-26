import prisma from "../../lib/prisma.js";
import { AppError } from "../../utils/AppError.js";
const events = {
  ENROLLMENT_FOR_VALIDATION: ["account", "Enrollment under review", "Gisusi ang enrollment", "Staff are reviewing your enrollment. Open Enrollment status for details.", "Gisusi sa staff ang imong enrollment. Ablihi ang Kahimtang sa enrollment alang sa detalye."],
  ENROLLMENT_NEEDS_CORRECTION: ["account", "Enrollment needs correction", "Kinahanglang tul-iron ang enrollment", "Staff requested a correction. Open Enrollment status and Enrollment documents for details.", "Naghangyo ang staff og pagtul-id. Ablihi ang Kahimtang sa enrollment ug Mga dokumento sa enrollment."],
  ENROLLMENT_APPROVED: ["account", "Enrollment approved", "Naaprubahan ang enrollment", "Your enrollment was approved. Staff will assign a claiming schedule separately.", "Naaprubahan ang imong enrollment. Ang staff maoy mo-assign sa iskedyul sa pag-claim."],
  ENROLLMENT_REJECTED: ["account", "Enrollment not approved", "Wala maaprubahan ang enrollment", "Your enrollment was not approved. Open Enrollment status for staff feedback.", "Wala maaprubahan ang imong enrollment. Ablihi ang Kahimtang sa enrollment alang sa tubag sa staff."],
  SCHEDULE_PUBLISHED: ["schedule", "Claiming schedule available", "Anaa na ang iskedyul sa pag-claim", "Your claiming schedule is available. Open Home and refresh your schedule to check the date, time, venue and queue number.", "Anaa na ang imong iskedyul sa pag-claim. Ablihi ang Home ug i-refresh ang iskedyul aron makita ang petsa, oras, lugar ug numero sa pila."],
  CLAIM_VERIFIED: ["claim", "Claim identity verified", "Napamatud-an ang identidad sa claim", "Staff completed your claim verification. Release is recorded separately. Check Wallet for the current status.", "Nakompleto sa staff ang pag-verify sa imong claim. Gilain og rekord ang paghatag sa ayuda. Susihon ang Wallet alang sa kasamtangang kahimtang."],
  ASSISTANCE_RELEASED: ["claim", "Assistance release recorded", "Narekord ang paghatag sa ayuda", "Staff recorded a physical assistance handover. Open Wallet to check the package, release time and available receipt number.", "Girekord sa staff ang paghatag sa pisikal nga ayuda. Ablihi ang Wallet aron makita ang pakete, oras sa paghatag ug anaa nga numero sa resibo."],
  BENEFIT_CREDITED_SIMULATED: ["claim", "Simulated benefit credit recorded", "Narekord ang simulated benefit credit", "A prototype benefit credit was recorded. No real funds moved. Open Wallet for the ledger entry.", "Narekord ang prototype benefit credit. Walay tinuod nga kuwarta nga gibalhin. Ablihi ang Wallet alang sa rekord."],
  BENEFIT_REVERSED_SIMULATED: ["claim", "Simulated benefit credit reversed", "Gibali ang simulated benefit credit", "Staff reversed a prototype benefit credit. No real funds moved. Open Wallet for the updated ledger.", "Gibali sa staff ang prototype benefit credit. Walay tinuod nga kuwarta nga gibalhin. Ablihi ang Wallet alang sa bag-ong rekord."],
};

function visibleWhere(session, now = new Date()) {
  const beneficiaryId = session.account.beneficiaryId;
  return { beneficiaryId, channel: "IN_APP", status: { in: ["SENT", "READ"] }, sentAt: { lte: now },
    OR: [{ scheduleId: null }, { schedule: { beneficiaryId } }] };
}

export async function getMobileNotifications(session) {
  // ponytail: own-account prototype inbox is unpaginated; add cursors before a large pilot.
  const rows = await prisma.notification.findMany({ where: visibleWhere(session),
    select: { notificationId: true, scheduleId: true, notificationType: true, message: true, messageBs: true, sentAt: true, readAt: true },
    orderBy: [{ sentAt: "desc" }, { notificationId: "desc" }] });
  return rows.map(row => {
    const event = events[row.notificationType];
    return { id: row.notificationId, scheduleId: row.scheduleId,
      title: event?.[1] ?? "Account update", titleBs: event?.[2] ?? "Update sa account",
      message: row.message, messageBs: row.messageBs, notificationType: event?.[0] ?? "account",
      sentAt: row.sentAt.toISOString(), readAt: row.readAt?.toISOString() ?? null };
  });
}

export async function readMobileNotification(session, notificationId) {
  const where = { ...visibleWhere(session), notificationId };
  await prisma.notification.updateMany({ where: { ...where, readAt: null }, data: { readAt: new Date() } });
  const row = await prisma.notification.findFirst({ where, select: { notificationId: true, readAt: true } });
  if (!row) throw new AppError(404, "NOTIFICATION_NOT_FOUND", "Notification not found.");
  return { id: row.notificationId, readAt: row.readAt.toISOString() };
}
