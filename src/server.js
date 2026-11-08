import { createServer } from "node:http";
import app from "./app.js";
import { env } from "./config/env.js";
import { attachRealtimeServer, clearRealtimePublisher } from "./realtime/socket.js";
import { closeNotificationQueue } from "./queues/notification.queue.js";
import prisma from "./lib/prisma.js";
import { readinessPool } from "./lib/readiness.js";
import { startAssistantHistoryCleanup } from "./modules/chatbot/assistantHistory.service.js";
import { startBeneficiaryImportWorker } from "./workers/beneficiaryImport.worker.js";
import { startProgramImportWorker } from "./workers/programImport.worker.js";
import { startStaffImportWorker } from "./workers/staffImport.worker.js";
import {
  closeNotificationRealtimeSubscriber,
  startNotificationRealtimeSubscriber,
} from "./realtime/notification.relay.js";

const server = createServer(app);
const io = attachRealtimeServer(server);
const stopWorkers = [];

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Cannot start GarantiyAid API: port ${env.port} is already in use. Another backend may already be running.`);
    console.error("Keep only one backend terminal running. To restart it, press Ctrl+C in that terminal, then run npm start there.");
  } else {
    console.error(`Cannot start GarantiyAid API (${error.code ?? "SERVER_ERROR"}).`);
  }
  shutdown("Server error", 1);
});

server.listen(env.port, () => {
  // A second instance must not process jobs before it can own the API port.
  void startNotificationRealtimeSubscriber();
  stopWorkers.push(startProgramImportWorker(), startStaffImportWorker(), startBeneficiaryImportWorker(), startAssistantHistoryCleanup());
  console.log(`GarantiyAid API listening on port ${env.port}.`);
});

let shuttingDown = false;

async function closeResources(exitCode) {
  try {
    await Promise.all(stopWorkers.map((stop) => stop()));
    await closeNotificationQueue();
    await closeNotificationRealtimeSubscriber();
    await prisma.$disconnect();
    await readinessPool.end();
    process.exit(exitCode);
  } catch {
    process.exit(1);
  }
}

function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Closing GarantiyAid API.`);
  clearRealtimePublisher(io);
  io.close((error) => {
    void closeResources(error && error.code !== "ERR_SERVER_NOT_RUNNING" ? 1 : exitCode);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
