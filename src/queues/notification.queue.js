import { Queue } from "bullmq";
import { env } from "../config/env.js";
import { createRedisConnection, closeRedisConnection } from "../lib/redis.js";

export const NOTIFICATION_JOB_NAME = "send-simulated-sms";
export const STAFF_EMAIL_JOB_NAME = "send-staff-security-email";

let notificationQueue = null;
let notificationQueueConnection = null;

export function notificationJobId(notificationId) {
  return `notification-${notificationId}`;
}

export function staffEmailJobId(notificationId) {
  return `staff-email-${notificationId}`;
}

export function notificationJobOptions(notification, now = new Date()) {
  const scheduledFor = notification.scheduledFor
    ? new Date(notification.scheduledFor)
    : now;
  return {
    jobId: notificationJobId(notification.notificationId),
    delay: Math.max(0, scheduledFor.getTime() - now.getTime()),
    attempts: env.notificationMaxAttempts,
    backoff: {
      type: "exponential",
      delay: env.notificationBackoffMs,
    },
    removeOnComplete: true,
    removeOnFail: true,
  };
}

export function getNotificationQueue() {
  if (!notificationQueue) {
    notificationQueueConnection = createRedisConnection("garantiyaid-notification-api");
    notificationQueue = new Queue(env.notificationQueueName, {
      connection: notificationQueueConnection,
    });
    notificationQueue.on("error", (error) => {
      if (env.nodeEnv !== "test") {
        console.warn({
          event: "NOTIFICATION_QUEUE_ERROR",
          errorName: error.name,
        });
      }
    });
  }
  return notificationQueue;
}

export async function enqueueNotificationJobs(
  notifications,
  { queue = getNotificationQueue(), now = new Date() } = {},
) {
  if (notifications.length === 0) return [];
  return queue.addBulk(notifications.map((notification) => ({
    name: NOTIFICATION_JOB_NAME,
    data: { notificationId: notification.notificationId },
    opts: notificationJobOptions(notification, now),
  })));
}

export async function enqueueStaffEmailJobs(
  notifications,
  { queue = getNotificationQueue() } = {},
) {
  if (notifications.length === 0) return [];
  return queue.addBulk(notifications.map((notification) => ({
    name: STAFF_EMAIL_JOB_NAME,
    data: { notificationId: notification.notificationId },
    opts: {
      jobId: staffEmailJobId(notification.notificationId),
      attempts: env.notificationMaxAttempts,
      backoff: { type: "exponential", delay: env.notificationBackoffMs },
      removeOnComplete: true,
      removeOnFail: true,
    },
  })));
}

export async function notificationQueueHealth({ queue = getNotificationQueue() } = {}) {
  try {
    await queue.waitUntilReady();
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
    return {
      status: "ready",
      queueName: env.notificationQueueName,
      jobType: NOTIFICATION_JOB_NAME,
      jobTypes: [NOTIFICATION_JOB_NAME, STAFF_EMAIL_JOB_NAME],
      emailProviderMode: env.emailProviderMode,
      counts,
      simulatedSmsOnly: true,
    };
  } catch {
    return {
      status: "unavailable",
      queueName: env.notificationQueueName,
      jobType: NOTIFICATION_JOB_NAME,
      jobTypes: [NOTIFICATION_JOB_NAME, STAFF_EMAIL_JOB_NAME],
      emailProviderMode: env.emailProviderMode,
      simulatedSmsOnly: true,
    };
  }
}

export async function closeNotificationQueue() {
  const queue = notificationQueue;
  const connection = notificationQueueConnection;
  notificationQueue = null;
  notificationQueueConnection = null;
  if (queue) await queue.close();
  await closeRedisConnection(connection);
}
