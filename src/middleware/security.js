import { randomUUID } from "node:crypto";
import { AppError } from "../utils/AppError.js";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const ACCEPTED_BODY_TYPES = ["application/json", "multipart/form-data"];

export function attachRequestContext(req, res, next) {
  req.requestId = randomUUID();
  res.set("X-Request-Id", req.requestId);
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  return next();
}

export function logCompletedRequest(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    if (process.env.NODE_ENV !== "production") {
      return;
    }

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    console.info({
      event: "HTTP_REQUEST",
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      ipAddress: req.ip,
      userId: req.auth?.userId ?? null,
      occurredAt: new Date().toISOString(),
    });
  });

  return next();
}

export function enforceHttps(req, res, next) {
  if (req.secure) {
    return next();
  }

  return next(new AppError(
    400,
    "HTTPS_REQUIRED",
    "HTTPS is required for this API.",
  ));
}

export function requireSupportedContentType(req, res, next) {
  if (!BODY_METHODS.has(req.method)) {
    return next();
  }

  const contentLength = Number.parseInt(req.get("content-length") ?? "0", 10);
  const hasBody = contentLength > 0 || Boolean(req.get("transfer-encoding"));

  if (!hasBody || req.is(ACCEPTED_BODY_TYPES)) {
    return next();
  }

  return next(new AppError(
    415,
    "UNSUPPORTED_MEDIA_TYPE",
    "Request bodies must use application/json or multipart/form-data.",
  ));
}
