import { Worker } from "bullmq";
import prisma from "../lib/prisma.js";
import { env } from "../config/env.js";
import { createRedisConnection, closeRedisConnection } from "../lib/redis.js";
import { NOTIFICATION_JOB_NAME, STAFF_EMAIL_JOB_NAME } from "../queues/notification.queue.js";
import { markExhaustedNotificationJob, processNotificationJob } from "./notification.processor.js";
import { markExhaustedStaffEmailJob, processStaffEmailJob } from "./staffEmail.processor.js";
import { closeNotificationRealtimePublisher } from "../realtime/notification.relay.js";

const connection = createRedisConnection("garantiyaid-notification-worker", { worker: true });
const worker = new Worker(
  env.notificationQueueName,
  async (job) => {
    if (job.name === NOTIFICATION_JOB_NAME) return processNotificationJob(job);
    if (job.name === STAFF_EMAIL_JOB_NAME) return processStaffEmailJob(job);
    throw new TypeError("Unsupported notification job type.");
  },
  {
    connection,
    concurrency: env.notificationWorkerConcurrency,
  },
);

worker.on("ready", () => {
  console.log(`Notification worker ready for queue ${env.notificationQueueName}.`);
});
worker.on("failed", (job, error) => {
  console.warn({
    event: "NOTIFICATION_JOB_ATTEMPT_FAILED",
    jobType: job?.name,
    notificationId: job?.data?.notificationId,
    attemptsMade: job?.attemptsMade,
    errorCode: error.code ?? "SIMULATED_PROVIDER_FAILURE",
  });
  const attemptsAllowed = Number(job?.opts?.attempts ?? env.notificationMaxAttempts);
  if (job?.data?.notificationId && job.attemptsMade >= attemptsAllowed) {
    const markExhausted = job.name === STAFF_EMAIL_JOB_NAME
      ? markExhaustedStaffEmailJob
      : markExhaustedNotificationJob;
    void markExhausted(job.data.notificationId).catch((markError) => {
      console.warn({
        event: "NOTIFICATION_EXHAUSTED_STATE_UPDATE_FAILED",
        notificationId: job.data.notificationId,
        errorName: markError.name,
      });
    });
  }
});
worker.on("error", (error) => {
  console.warn({
    event: "NOTIFICATION_WORKER_ERROR",
    errorName: error.name,
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Closing notification worker.`);
  try {
    await worker.close();
    await closeNotificationRealtimePublisher();
    await closeRedisConnection(connection);
    await prisma.$disconnect();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
