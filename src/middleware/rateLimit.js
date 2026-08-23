import { rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";

function rateLimitHandler(req, res) {
  return res.status(429).json({
    success: false,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests. Wait before trying again.",
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

export const apiRateLimiter = rateLimit({
  ...commonOptions,
  identifier: "garantiyaid-api",
  limit: env.apiRateLimitPer15Minutes,
});

export const authenticationRateLimiter = rateLimit({
  ...commonOptions,
  identifier: "garantiyaid-authentication",
  limit: env.authRateLimitPer15Minutes,
  skipSuccessfulRequests: true,
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
