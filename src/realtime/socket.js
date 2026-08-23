import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { env } from "../config/env.js";
import prisma from "../lib/prisma.js";
import { verifyAccessToken } from "../modules/auth/auth.service.js";

export const REALTIME_EVENT_NAMES = Object.freeze([
  "distribution.updated",
  "schedule.checked_in",
  "qr.scan.recorded",
  "claim.updated",
  "biometric.attempt.recorded",
  "wallet.transaction.completed",
  "wallet.transaction.reversed",
  "dashboard.metrics.updated",
  "anomaly.detected",
  "notification.queued",
  "notification.sent",
  "notification.failed",
  "notification.metrics.updated",
  "chatbot.session.escalated",
  "chatbot.staff_reply.created",
  "chatbot.session.resolved",
  "chatbot.metrics.updated",
]);

const REALTIME_EVENTS = new Set(REALTIME_EVENT_NAMES);
const GLOBAL_REALTIME_ROLES = Object.freeze(["SYSTEM_ADMIN", "DSWD_STAFF"]);
const GLOBAL_ONLY_EVENTS = new Set([
  "wallet.transaction.completed",
  "wallet.transaction.reversed",
]);
const SENSITIVE_KEY_FRAGMENTS = Object.freeze([
  "password",
  "secret",
  "token",
  "hash",
  "embedding",
  "facecapture",
  "biometrictemplate",
  "totp",
  "otp",
  "authorization",
  "cookie",
  "contactnumber",
  "recipient",
  "message",
  "philsys",
]);

let activeIo = null;

function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sensitiveKey(key) {
  const normalized = normalizedKey(key);
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export function sanitizeRealtimePayload(value) {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitizeRealtimePayload(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !sensitiveKey(key))
        .map(([key, nested]) => [
          key,
          normalizedKey(key) === "realfundsmoved" ? false : sanitizeRealtimePayload(nested),
        ]),
    );
  }
  return undefined;
}

function handshakeToken(socket) {
  const authToken = socket.handshake.auth?.accessToken ?? socket.handshake.auth?.token;
  if (typeof authToken === "string" && authToken.trim()) return authToken.trim();
  const authorization = socket.handshake.headers.authorization;
  if (typeof authorization !== "string") return null;
  const [scheme, token] = authorization.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

export async function authenticateSocketConnection(socket, database = prisma) {
  const token = handshakeToken(socket);
  if (!token) {
    const error = new Error("A staff access token is required.");
    error.data = { code: "AUTHENTICATION_REQUIRED" };
    throw error;
  }
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    const error = new Error("The staff access token is invalid or expired.");
    error.data = { code: "INVALID_TOKEN" };
    throw error;
  }
  const [user, session] = await Promise.all([
    database.user.findUnique({
      where: { userId: payload.sub },
      select: {
        userId: true,
        role: true,
        barangayId: true,
        isActive: true,
      },
    }),
    database.staffSession.findFirst({
      where: {
        sessionId: payload.jti,
        userId: payload.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { sessionId: true },
    }),
  ]);
  if (!user?.isActive || !session) {
    const error = new Error("This staff session is invalid, expired, or inactive.");
    error.data = { code: "INVALID_SESSION" };
    throw error;
  }
  if (user.role === "BARANGAY_FACILITATOR" && !user.barangayId) {
    const error = new Error("This facilitator has no assigned barangay.");
    error.data = { code: "BARANGAY_ASSIGNMENT_REQUIRED" };
    throw error;
  }
  return user;
}

export function realtimeRoomsForStaff(staffUser) {
  if (GLOBAL_REALTIME_ROLES.includes(staffUser.role)) {
    return [`role:${staffUser.role}`];
  }
  if (staffUser.role === "BARANGAY_FACILITATOR" && staffUser.barangayId) {
    return [`barangay:${staffUser.barangayId}`];
  }
  return [];
}

export function configureRealtimePublisher(io) {
  activeIo = io;
}

export function clearRealtimePublisher(io) {
  if (activeIo === io) activeIo = null;
}

async function resolveBarangayId(distributionId, barangayId, database) {
  if (barangayId) return barangayId;
  if (!distributionId) return null;
  const distribution = await database.distribution.findUnique({
    where: { distributionId },
    select: { barangayId: true },
  });
  return distribution?.barangayId ?? null;
}

export async function publishRealtimeEvent(
  eventName,
  { distributionId = null, barangayId = null, data = {} } = {},
  database = prisma,
) {
  if (!activeIo) return false;
  if (!REALTIME_EVENTS.has(eventName)) {
    throw new TypeError(`Unsupported realtime event: ${eventName}`);
  }
  try {
    const resolvedBarangayId = await resolveBarangayId(distributionId, barangayId, database);
    const envelope = {
      eventId: randomUUID(),
      event: eventName,
      occurredAt: new Date().toISOString(),
      ...(distributionId ? { distributionId } : {}),
      ...(resolvedBarangayId ? { barangayId: resolvedBarangayId } : {}),
      data: sanitizeRealtimePayload(data),
    };
    let target = activeIo.to("role:SYSTEM_ADMIN").to("role:DSWD_STAFF");
    if (resolvedBarangayId && !GLOBAL_ONLY_EVENTS.has(eventName)) {
      target = target.to(`barangay:${resolvedBarangayId}`);
    }
    target.emit(eventName, envelope);
    return true;
  } catch (error) {
    if (env.nodeEnv !== "test") {
      console.warn({
        event: "REALTIME_PUBLISH_FAILED",
        eventName,
        distributionId,
        errorName: error.name,
      });
    }
    return false;
  }
}

export function attachRealtimeServer(
  httpServer,
  { authenticate = authenticateSocketConnection } = {},
) {
  const io = new Server(httpServer, {
    serveClient: false,
    transports: ["websocket", "polling"],
    cors: {
      origin: env.corsOrigins,
      methods: ["GET", "POST"],
      allowedHeaders: ["Authorization"],
      credentials: false,
    },
  });
  io.use(async (socket, next) => {
    try {
      socket.data.staffUser = await authenticate(socket);
      return next();
    } catch (error) {
      return next(error);
    }
  });
  io.on("connection", (socket) => {
    const staffUser = socket.data.staffUser;
    const rooms = realtimeRoomsForStaff(staffUser);
    for (const room of rooms) socket.join(room);
    socket.emit("realtime.ready", {
      connected: true,
      role: staffUser.role,
      barangayId: staffUser.role === "BARANGAY_FACILITATOR" ? staffUser.barangayId : null,
      serverEventsOnly: true,
    });
    socket.onAny((eventName) => {
      socket.emit("realtime.error", {
        code: "CLIENT_EVENT_PUBLICATION_FORBIDDEN",
        message: `Clients cannot publish trusted event ${String(eventName).slice(0, 80)}.`,
      });
    });
  });
  configureRealtimePublisher(io);
  return io;
}
