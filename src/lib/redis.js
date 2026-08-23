import IORedis from "ioredis";
import { env } from "../config/env.js";

const REDIS_ERROR_LOG_INTERVAL_MS = 30_000;
const REMOTE_REDIS_TCP_KEEP_ALIVE_MS = 30_000;

export function redisTcpKeepAliveDelay(redisUrl = env.redisUrl) {
  const hostname = new URL(redisUrl).hostname.toLowerCase();
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname)
    ? null
    : REMOTE_REDIS_TCP_KEEP_ALIVE_MS;
}

function safeErrorValue(value, maximumLength = 240) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, maximumLength);
}

export function redisConnectionErrorDetails(error) {
  const details = {
    errorName: safeErrorValue(error?.name, 80) ?? "Error",
  };
  for (const [sourceKey, outputKey] of [
    ["code", "errorCode"],
    ["message", "errorMessage"],
    ["errno", "errorNumber"],
    ["syscall", "syscall"],
    ["address", "address"],
    ["port", "port"],
  ]) {
    const value = safeErrorValue(error?.[sourceKey]);
    if (value !== null) details[outputKey] = value;
  }
  return details;
}

export function createRedisErrorReporter({
  errorEvent,
  recoveryEvent,
  logIntervalMs = REDIS_ERROR_LOG_INTERVAL_MS,
  now = () => Date.now(),
  warn = (entry) => console.warn(entry),
  info = (entry) => console.info(entry),
}) {
  let failureStartedAt = null;
  let lastLoggedAt = null;
  let suppressedErrors = 0;

  function reset() {
    failureStartedAt = null;
    lastLoggedAt = null;
    suppressedErrors = 0;
  }

  return {
    report(error) {
      const timestamp = now();
      failureStartedAt ??= timestamp;
      if (lastLoggedAt !== null && timestamp - lastLoggedAt < logIntervalMs) {
        suppressedErrors += 1;
        return false;
      }
      warn({
        event: errorEvent,
        ...redisConnectionErrorDetails(error),
        retrying: true,
        ...(suppressedErrors > 0 ? { suppressedErrors } : {}),
      });
      lastLoggedAt = timestamp;
      suppressedErrors = 0;
      return true;
    },
    recovered(context = {}) {
      if (failureStartedAt === null) return false;
      info({
        ...context,
        event: recoveryEvent,
        downtimeMs: Math.max(0, now() - failureStartedAt),
        ...(suppressedErrors > 0 ? { suppressedErrors } : {}),
      });
      reset();
      return true;
    },
    reset,
  };
}

export function createRedisConnection(connectionName, { worker = false } = {}) {
  return new IORedis(env.redisUrl, {
    connectionName,
    lazyConnect: true,
    connectTimeout: 3_000,
    // Docker Desktop/WSL host forwarding can reset localhost connections when
    // Node sends its first TCP keep-alive probe. The long-lived subscriber uses
    // a Redis PING heartbeat instead; remote deployments retain TCP keep-alive.
    keepAlive: redisTcpKeepAliveDelay(),
    maxRetriesPerRequest: worker ? null : 1,
    enableReadyCheck: true,
    retryStrategy(times) {
      return Math.min(times * 250, 5_000);
    },
  });
}

export async function closeRedisConnection(connection) {
  if (!connection) return;
  if (connection.status === "ready") {
    await connection.quit();
    return;
  }
  connection.disconnect(false);
}
