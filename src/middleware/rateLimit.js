import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";
import { verifyAccessToken } from "../modules/auth/auth.service.js";
import { verifyMobileAccessToken } from "../modules/beneficiaries/mobileAccount.auth.js";

function rateLimitHandler(req, res, _next, options) {
  const retryAfterSeconds = Math.max(1, Math.ceil((req.rateLimit.resetTime.getTime() - Date.now()) / 1000));
  const wait = retryAfterSeconds >= 60 ? `${Math.ceil(retryAfterSeconds / 60)} minute(s)` : `${retryAfterSeconds} second(s)`;
  return res.status(429).json({
    success: false,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: `Too many requests. Try again in ${wait}.`,
      retryAfterSeconds,
      scope: options.identifier,
      requestId: req.requestId,
    },
  });
}

const commonOptions = {
  windowMs: 15 * 60 * 1000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  passOnStoreError: false,
  handler: rateLimitHandler,
};

export function apiRateLimitKey(req) {
  const [scheme, token] = req.get("authorization")?.split(" ") ?? [];
  if (scheme === "Bearer" && token) {
    try { return `staff:${verifyAccessToken(token).sub}`; } catch { /* Invalid credentials still share the client-address limit. */ }
    try {
      const identity = verifyMobileAccessToken(token);
      return `mobile:${identity.issuer}:${identity.subject}`;
    } catch { /* Only signed mobile identities receive an individual quota. */ }
  }
  return `ip:${ipKeyGenerator(req.ip)}`;
}

export const apiRateLimiter = rateLimit({
  ...commonOptions,
  identifier: "garantiyaid-api",
  limit: env.apiRateLimitPer15Minutes,
  keyGenerator: apiRateLimitKey,
});

export const authenticationRateLimiter = rateLimit({
  ...commonOptions,
  identifier: "garantiyaid-authentication",
  limit: env.authRateLimitPer15Minutes,
  skipSuccessfulRequests: true,
});

export const passwordResetRateLimiter = rateLimit({
  ...commonOptions,
  identifier: "garantiyaid-password-reset",
  limit: env.passwordResetRateLimitPer15Minutes,
});

export const totpRateLimiter = rateLimit({
  ...commonOptions,
  identifier: "garantiyaid-totp",
  limit: env.authRateLimitPer15Minutes,
});

export const biometricRateLimiter = rateLimit({
  ...commonOptions,
  identifier: "garantiyaid-biometric",
  limit: env.biometricRateLimitPer15Minutes,
});

export const reportRateLimiter = rateLimit({
  ...commonOptions,
  identifier: "garantiyaid-reports",
  limit: env.reportRateLimitPer15Minutes,
});

export const notificationRateLimiter = rateLimit({
  ...commonOptions,
  identifier: "garantiyaid-notifications",
  limit: env.notificationRateLimitPer15Minutes,
});

export const chatbotRateLimiter = rateLimit({
  ...commonOptions,
  identifier: "garantiyaid-chatbot",
  limit: env.chatbotRateLimitPer15Minutes,
});
