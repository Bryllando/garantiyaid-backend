import { randomUUID } from "node:crypto";
import prisma from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { enqueueStaffEmailJobs } from "../../queues/notification.queue.js";
import {
  createStaffNotification,
  emailDeliveryToResponse,
  publishStaffNotificationCreated,
} from "./staffNotification.service.js";

const securityMessages = {
  ACCOUNT_CREATED: (user) => ({
    title: "Your GarantiyAid staff account is ready",
    message: `Your administrator created your staff account.\n\nStaff ID: ${user.employeeId}\n\nGet your temporary password directly from the administrator who created your account.\n\nAt first sign-in:\n1. Set a new password.\n2. Connect your authenticator app.\n3. Save your recovery codes.`,
    targetPath: "/login",
  }),
  PASSWORD_CHANGED: () => ({
    title: "Your GarantiyAid password was changed",
    message: "Your staff account password was changed and other active sessions were signed out. If you did not make this change, contact a System Administrator immediately.",
    targetPath: "/account?section=password",
  }),
  PASSWORD_RESET_REQUESTED: () => ({
    title: "Reset your GarantiyAid staff password",
    message: `A password reset was requested for your staff account. Use the secure link below within ${env.passwordResetTokenMinutes} minutes. If you did not request this, you can ignore this message and keep your current password.`,
    targetPath: "/login",
  }),
  PASSWORD_RESET_COMPLETED: () => ({
    title: "Your GarantiyAid password was reset",
    message: "Your staff password was reset and every active session was signed out. Sign in again with your new password and existing authenticator. If you did not complete this reset, contact a System Administrator immediately.",
    targetPath: "/login",
  }),
  AUTHENTICATOR_ENABLED: () => ({
    title: "Authenticator added to your GarantiyAid account",
    message: "An authenticator was connected to your staff account. Keep your recovery codes private. If you did not complete this setup, contact a System Administrator immediately.",
    targetPath: "/account?section=authenticator",
  }),
  AUTHENTICATOR_REPLACED: () => ({
    title: "Your GarantiyAid authenticator was replaced",
    message: "A new authenticator was connected to your staff account. The previous authenticator and recovery codes no longer work. If you did not make this change, contact a System Administrator immediately.",
    targetPath: "/account?section=authenticator",
  }),
  AUTHENTICATOR_RESET: () => ({
    title: "Your GarantiyAid authenticator was reset",
    message: "A System Administrator reset your authenticator and ended your active sessions. Sign in again to connect a new authenticator. If you did not request this reset, contact your office immediately.",
    targetPath: "/login",
  }),
  ACCOUNT_DEACTIVATED: () => ({
    title: "Your GarantiyAid staff account was deactivated",
    message: "A System Administrator deactivated your staff account and signed out its active sessions. You cannot sign in while the account is inactive.\n\nIf this was unexpected, contact the System Administrator who manages your account through your office’s usual contact method.",
    targetPath: null,
  }),
  ACCOUNT_REACTIVATED: () => ({
    title: "Your GarantiyAid staff account was reactivated",
    message: "A System Administrator reactivated your staff account. You may sign in again using your existing Staff ID and password.",
    targetPath: "/login",
  }),
};

export function emailDeliveryConfiguration() {
  return {
    configured: env.emailProviderMode === "GMAIL_API",
    provider: env.emailProviderMode,
  };
}

export async function createStaffSecurityNotification({
  event,
  user,
  eventKey,
}, database = prisma) {
  const render = securityMessages[event];
  if (!render) throw new TypeError(`Unsupported staff security email event: ${event}`);
  const content = render(user);
  return createStaffNotification({
    userId: user.userId,
    notificationType: `SECURITY_${event}`,
    title: content.title,
    message: content.message,
    targetPath: content.targetPath,
    deduplicationKey: `security:${event}:${eventKey ?? randomUUID()}`.slice(0, 160),
    emailRecipient: user.email,
  }, database);
}

export async function dispatchStaffSecurityNotification(
  notification,
  { database = prisma, enqueue = enqueueStaffEmailJobs, deliveryTargetPath } = {},
) {
  await publishStaffNotificationCreated(notification).catch(() => false);
  if (notification.emailStatus !== "PENDING") return emailDeliveryToResponse(notification);

  try {
    await enqueue([notification], { deliveryTargetPath });
    return emailDeliveryToResponse(notification);
  } catch {
    await database.staffNotification.updateMany({
      where: { notificationId: notification.notificationId, emailStatus: "PENDING" },
      data: {
        emailStatus: "FAILED",
        emailLastErrorCode: "EMAIL_QUEUE_UNAVAILABLE",
        emailFailedAt: new Date(),
      },
    });
    return emailDeliveryToResponse({
      ...notification,
      emailStatus: "FAILED",
      emailLastErrorCode: "EMAIL_QUEUE_UNAVAILABLE",
    });
  }
}
