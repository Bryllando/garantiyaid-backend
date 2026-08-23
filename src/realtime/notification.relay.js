import { env } from "../config/env.js";
import {
  closeRedisConnection,
  createRedisConnection,
  createRedisErrorReporter,
  redisConnectionErrorDetails,
} from "../lib/redis.js";
import { publishRealtimeEvent } from "./socket.js";

const NOTIFICATION_RELAY_CHANNEL = `${env.notificationQueueName}:realtime`;
export const NOTIFICATION_RELAY_HEARTBEAT_MS = 15_000;
const RELAYED_NOTIFICATION_EVENTS = new Set([
  "notification.sent",
  "notification.failed",
]);
const RELAY_DATA_KEYS = Object.freeze([
  "notificationId",
  "beneficiaryId",
  "scheduleId",
  "notificationType",
  "channel",
  "status",
  "errorCode",
  "simulated",
  "realSmsSent",
]);

let publisherConnection = null;
let subscriberConnection = null;
let subscriberStartPromise = null;
let subscriberHasSubscribed = false;
let subscriberHeartbeatTimer = null;
let subscriberHeartbeatInFlight = false;
const subscriberErrorReporter = createRedisErrorReporter({
  errorEvent: "NOTIFICATION_REALTIME_RELAY_ERROR",
  recoveryEvent: "NOTIFICATION_REALTIME_RELAY_RECOVERED",
});

function stopSubscriberHeartbeat() {
  if (subscriberHeartbeatTimer) clearInterval(subscriberHeartbeatTimer);
  subscriberHeartbeatTimer = null;
  subscriberHeartbeatInFlight = false;
}

function startSubscriberHeartbeat() {
  stopSubscriberHeartbeat();
  subscriberHeartbeatTimer = setInterval(() => {
    const connection = subscriberConnection;
    if (!connection || connection.status !== "ready" || subscriberHeartbeatInFlight) return;
    subscriberHeartbeatInFlight = true;
    void connection.ping()
      .catch(() => {
        // The connection's error listener emits the safe, throttled diagnostic.
      })
      .finally(() => {
        subscriberHeartbeatInFlight = false;
      });
  }, NOTIFICATION_RELAY_HEARTBEAT_MS);
  subscriberHeartbeatTimer.unref?.();
}

function safeString(value, maximumLength = 100) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength
    ? value
    : null;
}

function safeRelayData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = {};
  for (const key of RELAY_DATA_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    if (key === "simulated" || key === "realSmsSent") {
      if (typeof value[key] === "boolean") data[key] = value[key];
      continue;
    }
    const safeValue = safeString(value[key]);
    if (safeValue) data[key] = safeValue;
  }
  return safeString(data.notificationId) ? data : null;
}

export function notificationRelayEnvelope(eventName, notification, data = {}) {
  if (!RELAYED_NOTIFICATION_EVENTS.has(eventName)) {
    throw new TypeError(`Unsupported notification relay event: ${eventName}`);
  }
  const relayData = safeRelayData({
    notificationId: notification.notificationId,
    beneficiaryId: notification.beneficiaryId,
    scheduleId: notification.scheduleId,
    notificationType: notification.notificationType,
    channel: notification.channel,
    ...data,
  });
  if (!relayData) throw new TypeError("Notification relay messages require a notificationId.");
  return {
    eventName,
    distributionId: safeString(notification.distributionId),
    barangayId: safeString(notification.beneficiary?.barangayId),
    data: relayData,
  };
}

function parseRelayMessage(message) {
  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!RELAYED_NOTIFICATION_EVENTS.has(parsed.eventName)) return null;
  const data = safeRelayData(parsed.data);
  if (!data) return null;
  return {
    eventName: parsed.eventName,
    distributionId: safeString(parsed.distributionId),
    barangayId: safeString(parsed.barangayId),
    data,
  };
}

export async function deliverNotificationRelayMessage(
  message,
  publish = publishRealtimeEvent,
) {
  const relay = parseRelayMessage(message);
  if (!relay) return false;
  await Promise.all([
    publish(relay.eventName, {
      distributionId: relay.distributionId,
      barangayId: relay.barangayId,
      data: relay.data,
    }),
    publish("notification.metrics.updated", {
      distributionId: relay.distributionId,
      barangayId: relay.barangayId,
      data: { reason: relay.eventName.toUpperCase().replaceAll(".", "_") },
    }),
  ]);
  return true;
}

export async function publishNotificationLifecycleFromWorker(eventName, notification, data = {}) {
  try {
    const relay = notificationRelayEnvelope(eventName, notification, data);
    publisherConnection ??= createRedisConnection("garantiyaid-notification-realtime-publisher");
    await publisherConnection.publish(NOTIFICATION_RELAY_CHANNEL, JSON.stringify(relay));
    return true;
  } catch (error) {
    if (env.nodeEnv !== "test") {
      console.warn({
        event: "NOTIFICATION_REALTIME_RELAY_PUBLISH_FAILED",
        eventName,
        notificationId: notification?.notificationId,
        errorName: error.name,
      });
    }
    return false;
  }
}

export function startNotificationRealtimeSubscriber() {
  if (subscriberStartPromise) return subscriberStartPromise;
  subscriberErrorReporter.reset();
  subscriberHasSubscribed = false;
  subscriberConnection = createRedisConnection("garantiyaid-notification-realtime-subscriber", {
    worker: true,
  });
  subscriberConnection.on("ready", () => {
    if (env.nodeEnv !== "test" && subscriberHasSubscribed) {
      subscriberErrorReporter.recovered({ channel: NOTIFICATION_RELAY_CHANNEL });
    }
  });
  subscriberConnection.on("message", (channel, message) => {
    if (channel !== NOTIFICATION_RELAY_CHANNEL) return;
    void deliverNotificationRelayMessage(message).catch((error) => {
      if (env.nodeEnv !== "test") {
        console.warn({
          event: "NOTIFICATION_REALTIME_RELAY_DELIVERY_FAILED",
          errorName: error.name,
        });
      }
    });
  });
  subscriberConnection.on("error", (error) => {
    if (env.nodeEnv !== "test") {
      subscriberErrorReporter.report(error);
    }
  });
  subscriberStartPromise = subscriberConnection.subscribe(NOTIFICATION_RELAY_CHANNEL)
    .then(() => {
      subscriberHasSubscribed = true;
      startSubscriberHeartbeat();
      if (env.nodeEnv !== "test") {
        const recovered = subscriberErrorReporter.recovered({ channel: NOTIFICATION_RELAY_CHANNEL });
        if (!recovered) {
          console.info({
            event: "NOTIFICATION_REALTIME_RELAY_READY",
            channel: NOTIFICATION_RELAY_CHANNEL,
          });
        }
      }
      return true;
    })
    .catch((error) => {
      if (env.nodeEnv !== "test") {
        console.warn({
          event: "NOTIFICATION_REALTIME_RELAY_SUBSCRIBE_FAILED",
          ...redisConnectionErrorDetails(error),
          retrying: false,
        });
      }
      return false;
    });
  return subscriberStartPromise;
}

export async function closeNotificationRealtimeSubscriber() {
  const connection = subscriberConnection;
  subscriberConnection = null;
  subscriberStartPromise = null;
  subscriberHasSubscribed = false;
  stopSubscriberHeartbeat();
  subscriberErrorReporter.reset();
  if (!connection) return;
  if (connection.status === "ready") await connection.unsubscribe(NOTIFICATION_RELAY_CHANNEL);
  await closeRedisConnection(connection);
}

export async function closeNotificationRealtimePublisher() {
  const connection = publisherConnection;
  publisherConnection = null;
  await closeRedisConnection(connection);
}
