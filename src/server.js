import { createServer } from "node:http";
import app from "./app.js";
import { env } from "./config/env.js";
import { attachRealtimeServer, clearRealtimePublisher } from "./realtime/socket.js";
import { closeNotificationQueue } from "./queues/notification.queue.js";
import prisma from "./lib/prisma.js";
import {
  closeNotificationRealtimeSubscriber,
  startNotificationRealtimeSubscriber,
} from "./realtime/notification.relay.js";

const server = createServer(app);
const io = attachRealtimeServer(server);
void startNotificationRealtimeSubscriber();

server.listen(env.port, () => {
  console.log(`GarantiyAid API listening on port ${env.port}.`);
});

let shuttingDown = false;

async function closeResources(exitCode) {
  try {
    await closeNotificationQueue();
    await closeNotificationRealtimeSubscriber();
    await prisma.$disconnect();
    process.exit(exitCode);
  } catch {
    process.exit(1);
  }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Closing GarantiyAid API.`);
  clearRealtimePublisher(io);
  io.close();
  if (!server.listening) {
    void closeResources(0);
    return;
  }
  server.close((error) => {
    void closeResources(error ? 1 : 0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
