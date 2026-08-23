import { closeNotificationQueue, notificationQueueHealth } from "../src/queues/notification.queue.js";

try {
  const health = await notificationQueueHealth();
  if (health.status !== "ready") {
    throw new Error("Notification queue is unavailable. Start Redis and retry.");
  }
  console.log(JSON.stringify({
    success: true,
    phase: 9,
    queueName: health.queueName,
    jobType: health.jobType,
    simulatedSmsOnly: true,
    realSmsSent: false,
    counts: health.counts,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    success: false,
    phase: 9,
    code: "NOTIFICATION_QUEUE_UNAVAILABLE",
    message: error.message,
    simulatedSmsOnly: true,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await closeNotificationQueue();
}
