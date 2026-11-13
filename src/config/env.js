import "dotenv/config";
import path from "node:path";
import { z } from "zod";
import { devAdminConfigurationError } from "../modules/auth/devAdmin.policy.js";

const duration = z.string().regex(/^\d+(?:s|m|h|d)$/, "Use a duration such as 15m or 1h.");
const optionalOpenRouterKey = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().regex(/^sk-or-v1-[A-Za-z0-9_-]{32,}$/, "Use a valid OpenRouter API key.").optional(),
);
const optionalTrimmedString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().optional(),
);

export function durationInMilliseconds(value) {
  const amount = Number.parseInt(value, 10);
  const unit = value.at(-1);
  const multipliers = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * multipliers[unit];
}

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DEV_QUICK_LOGIN_ENABLED: z.enum(["true", "false"]).default("false"),
  DEV_ADMIN_DATABASE: optionalTrimmedString,
  DEV_ADMIN_PASSWORD: optionalTrimmedString,
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:5173,http://127.0.0.1:5173"),
  DATABASE_URL: z.string().min(1).optional(),
  UPLOAD_ROOT: optionalTrimmedString.refine((value) => !value || path.isAbsolute(value), "UPLOAD_ROOT must be an absolute path."),
  JWT_ACCESS_SECRET: z.string().min(32).optional(),
  JWT_ACCESS_EXPIRES_IN: duration.default("15m"),
  JWT_ISSUER: z.string().trim().min(3).max(100).default("garantiyaid-api"),
  JWT_AUDIENCE: z.string().trim().min(3).max(100).default("garantiyaid-staff"),
  MOBILE_AUTH_PUBLIC_KEY: optionalTrimmedString,
  MOBILE_AUTH_ISSUER: z.string().trim().min(3).max(200).default("garantiyaid-mobile"),
  MOBILE_AUTH_AUDIENCE: z.string().trim().min(3).max(100).default("garantiyaid-beneficiary-api"),
  FIELD_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  ENFORCE_HTTPS: z.enum(["true", "false"]).default("false"),
  AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  AUTH_FAILURE_WINDOW_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
  AUTH_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  API_RATE_LIMIT_PER_15_MINUTES: z.coerce.number().int().min(50).max(10_000).default(300),
  AUTH_RATE_LIMIT_PER_15_MINUTES: z.coerce.number().int().min(3).max(100).default(10),
  PASSWORD_RESET_RATE_LIMIT_PER_15_MINUTES: z.coerce.number().int().min(2).max(50).default(5),
  PASSWORD_RESET_TOKEN_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
  BIOMETRIC_RATE_LIMIT_PER_15_MINUTES: z.coerce.number().int().min(3).max(200).default(30),
  REPORT_RATE_LIMIT_PER_15_MINUTES: z.coerce.number().int().min(10).max(1_000).default(100),
  NOTIFICATION_RATE_LIMIT_PER_15_MINUTES: z.coerce.number().int().min(5).max(500).default(60),
  CHATBOT_RATE_LIMIT_PER_15_MINUTES: z.coerce.number().int().min(5).max(300).default(30),
  CHATBOT_MAX_MESSAGES_PER_SESSION: z.coerce.number().int().min(10).max(500).default(100),
  CHATBOT_SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  CHATBOT_RETENTION_DAYS: z.coerce.number().int().min(30).max(365).default(90),
  OPENROUTER_API_KEY: optionalOpenRouterKey,
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  BIOMETRIC_PROCESSOR_MODE: z.enum(["SIMULATED", "REMOTE"]).default("SIMULATED"),
  BIOMETRIC_SERVICE_URL: z.url().optional(),
  BIOMETRIC_SERVICE_API_KEY: z.string().min(32).optional(),
  BIOMETRIC_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(90_000),
  BIOMETRIC_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  BIOMETRIC_LIVENESS_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.8),
  REDIS_URL: z.string().trim().refine(
    (value) => /^rediss?:\/\//i.test(value),
    "Use a redis:// or rediss:// URL.",
  ).default("redis://127.0.0.1:6379"),
  NOTIFICATION_QUEUE_NAME: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{2,49}$/).default("garantiyaid-notifications"),
  NOTIFICATION_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),
  NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  NOTIFICATION_BACKOFF_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  NOTIFICATION_BATCH_MAX_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  NOTIFICATION_MAX_DELAY_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  SMS_PROVIDER_MODE: z.enum(["SIMULATED", "SIMGATE"]).default("SIMULATED"),
  SMS_SIMULATED_FAILURE_MODE: z.enum(["NONE", "ALWAYS_FAIL"]).default("NONE"),
  SIMGATE_API_KEY: optionalTrimmedString,
  SIMGATE_DEVICE_ID: optionalTrimmedString,
  SMS_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(15_000),
  EMAIL_PROVIDER_MODE: z.enum(["DISABLED", "GMAIL_API", "BREVO_API"]).default("DISABLED"),
  BREVO_API_KEY: optionalTrimmedString,
  BREVO_SENDER_EMAIL: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.email().optional(),
  ),
  BREVO_SENDER_NAME: z.string().trim().min(1).max(80).default("GarantiyAid"),
  GMAIL_CLIENT_ID: optionalTrimmedString,
  GMAIL_CLIENT_SECRET: optionalTrimmedString,
  GMAIL_REFRESH_TOKEN: optionalTrimmedString,
  GMAIL_SENDER_EMAIL: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.email().optional(),
  ),
  GMAIL_SENDER_NAME: z.string().trim().min(1).max(80).default("GarantiyAid Security"),
  PUBLIC_APP_URL: z.url().default("http://localhost:5173"),
  EMAIL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  DISTRIBUTION_REMINDER_LEAD_MINUTES: z.coerce.number().int().min(1).max(10_080).default(1_440),
}).superRefine((value, context) => {
  const origins = value.CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);
  const devError = devAdminConfigurationError({
    devQuickLoginEnabled: value.DEV_QUICK_LOGIN_ENABLED === "true", nodeEnv: value.NODE_ENV,
    databaseUrl: value.DATABASE_URL, devAdminDatabase: value.DEV_ADMIN_DATABASE,
    corsOrigins: origins, trustProxyHops: value.TRUST_PROXY_HOPS,
  });
  if (devError) context.addIssue({ code: "custom", path: ["DEV_QUICK_LOGIN_ENABLED"], message: devError });

  if (origins.length === 0 || origins.includes("*")) {
    context.addIssue({
      code: "custom",
      path: ["CORS_ORIGIN"],
      message: "List explicit trusted origins; wildcard origins are not allowed.",
    });
  }

  if (value.SMS_PROVIDER_MODE === "SIMGATE") {
    for (const name of ["SIMGATE_API_KEY", "SIMGATE_DEVICE_ID"]) {
      if (!value[name] || /\s/.test(value[name])) {
        context.addIssue({ code: "custom", path: [name], message: `${name} is required without whitespace when SMS_PROVIDER_MODE is SIMGATE.` });
      }
    }
  }

  if (value.EMAIL_PROVIDER_MODE === "GMAIL_API") {
    for (const name of ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "GMAIL_SENDER_EMAIL"]) {
      if (!value[name]) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: `${name} is required when EMAIL_PROVIDER_MODE is GMAIL_API.`,
        });
      }
    }
  }

  if (value.EMAIL_PROVIDER_MODE === "BREVO_API") {
    for (const name of ["BREVO_API_KEY", "BREVO_SENDER_EMAIL"]) {
      if (!value[name]) {
        context.addIssue({ code: "custom", path: [name], message: `${name} is required when EMAIL_PROVIDER_MODE is BREVO_API.` });
      }
    }
    if (value.BREVO_API_KEY && /\s/.test(value.BREVO_API_KEY)) {
      context.addIssue({ code: "custom", path: ["BREVO_API_KEY"], message: "The Brevo API key must not contain whitespace." });
    }
  }

  if (value.EMAIL_PROVIDER_MODE !== "DISABLED" && !/^https?:\/\//.test(value.PUBLIC_APP_URL)) {
    context.addIssue({ code: "custom", path: ["PUBLIC_APP_URL"], message: "The public application URL must use HTTP or HTTPS." });
  }

  if (value.NODE_ENV !== "production") {
    return;
  }

  if (value.BIOMETRIC_PROCESSOR_MODE !== "REMOTE") {
    context.addIssue({
      code: "custom",
      path: ["BIOMETRIC_PROCESSOR_MODE"],
      message: "Production must use the remote biometric processor; the simulated adapter is test-only.",
    });
  }

  if (!value.BIOMETRIC_SERVICE_URL?.startsWith("https://")) {
    context.addIssue({
      code: "custom",
      path: ["BIOMETRIC_SERVICE_URL"],
      message: "Production biometric service URL must use HTTPS.",
    });
  }

  if (!value.BIOMETRIC_SERVICE_API_KEY) {
    context.addIssue({
      code: "custom",
      path: ["BIOMETRIC_SERVICE_API_KEY"],
      message: "Production biometric service authentication is required.",
    });
  }

  for (const name of ["DATABASE_URL", "JWT_ACCESS_SECRET", "FIELD_ENCRYPTION_KEY", "UPLOAD_ROOT"]) {
    if (!value[name]) {
      context.addIssue({
        code: "custom",
        path: [name],
        message: `${name} is required in production.`,
      });
    }
  }

  if ((value.JWT_ACCESS_SECRET?.length ?? 0) < 64) {
    context.addIssue({
      code: "custom",
      path: ["JWT_ACCESS_SECRET"],
      message: "Use at least 64 random characters in production.",
    });
  }

  const accessTokenLifetime = durationInMilliseconds(value.JWT_ACCESS_EXPIRES_IN);
  if (accessTokenLifetime < 5 * 60_000 || accessTokenLifetime > 60 * 60_000) {
    context.addIssue({
      code: "custom",
      path: ["JWT_ACCESS_EXPIRES_IN"],
      message: "Production staff access tokens must last between 5 minutes and 1 hour.",
    });
  }

  if (value.ENFORCE_HTTPS !== "true") {
    context.addIssue({
      code: "custom",
      path: ["ENFORCE_HTTPS"],
      message: "HTTPS enforcement must be enabled in production.",
    });
  }

  if (origins.some((origin) => !origin.startsWith("https://"))) {
    context.addIssue({
      code: "custom",
      path: ["CORS_ORIGIN"],
      message: "Every production CORS origin must use HTTPS.",
    });
  }

  if (value.EMAIL_PROVIDER_MODE !== "DISABLED" && !value.PUBLIC_APP_URL.startsWith("https://")) {
    context.addIssue({
      code: "custom",
      path: ["PUBLIC_APP_URL"],
      message: "The production public application URL must use HTTPS.",
    });
  }
});

const parsedEnvironment = environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
  const issues = parsedEnvironment.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");

  throw new Error(`Invalid environment configuration: ${issues}`);
}

export const env = {
  nodeEnv: parsedEnvironment.data.NODE_ENV,
  devQuickLoginEnabled: parsedEnvironment.data.DEV_QUICK_LOGIN_ENABLED === "true",
  devAdminDatabase: parsedEnvironment.data.DEV_ADMIN_DATABASE,
  devAdminPassword: parsedEnvironment.data.DEV_ADMIN_PASSWORD,
  port: parsedEnvironment.data.PORT,
  corsOrigins: parsedEnvironment.data.CORS_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  databaseUrl: parsedEnvironment.data.DATABASE_URL,
  uploadRoot: parsedEnvironment.data.UPLOAD_ROOT ?? path.resolve(process.cwd(), "uploads"),
  jwtAccessSecret: parsedEnvironment.data.JWT_ACCESS_SECRET,
  jwtAccessExpiresIn: parsedEnvironment.data.JWT_ACCESS_EXPIRES_IN,
  jwtIssuer: parsedEnvironment.data.JWT_ISSUER,
  jwtAudience: parsedEnvironment.data.JWT_AUDIENCE,
  mobileAuthPublicKey: parsedEnvironment.data.MOBILE_AUTH_PUBLIC_KEY?.replaceAll("\\n", "\n"),
  mobileAuthIssuer: parsedEnvironment.data.MOBILE_AUTH_ISSUER,
  mobileAuthAudience: parsedEnvironment.data.MOBILE_AUTH_AUDIENCE,
  fieldEncryptionKey: parsedEnvironment.data.FIELD_ENCRYPTION_KEY,
  trustProxyHops: parsedEnvironment.data.TRUST_PROXY_HOPS,
  enforceHttps: parsedEnvironment.data.ENFORCE_HTTPS === "true",
  authMaxFailedAttempts: parsedEnvironment.data.AUTH_MAX_FAILED_ATTEMPTS,
  authFailureWindowMinutes: parsedEnvironment.data.AUTH_FAILURE_WINDOW_MINUTES,
  authLockoutMinutes: parsedEnvironment.data.AUTH_LOCKOUT_MINUTES,
  apiRateLimitPer15Minutes: parsedEnvironment.data.API_RATE_LIMIT_PER_15_MINUTES,
  authRateLimitPer15Minutes: parsedEnvironment.data.AUTH_RATE_LIMIT_PER_15_MINUTES,
  passwordResetRateLimitPer15Minutes: parsedEnvironment.data.PASSWORD_RESET_RATE_LIMIT_PER_15_MINUTES,
  passwordResetTokenMinutes: parsedEnvironment.data.PASSWORD_RESET_TOKEN_MINUTES,
  biometricRateLimitPer15Minutes: parsedEnvironment.data.BIOMETRIC_RATE_LIMIT_PER_15_MINUTES,
  reportRateLimitPer15Minutes: parsedEnvironment.data.REPORT_RATE_LIMIT_PER_15_MINUTES,
  notificationRateLimitPer15Minutes: parsedEnvironment.data.NOTIFICATION_RATE_LIMIT_PER_15_MINUTES,
  chatbotRateLimitPer15Minutes: parsedEnvironment.data.CHATBOT_RATE_LIMIT_PER_15_MINUTES,
  chatbotMaxMessagesPerSession: parsedEnvironment.data.CHATBOT_MAX_MESSAGES_PER_SESSION,
  chatbotSessionMaxHours: parsedEnvironment.data.CHATBOT_SESSION_MAX_HOURS,
  chatbotRetentionDays: parsedEnvironment.data.CHATBOT_RETENTION_DAYS,
  openRouterApiKey: parsedEnvironment.data.OPENROUTER_API_KEY,
  idempotencyTtlHours: parsedEnvironment.data.IDEMPOTENCY_TTL_HOURS,
  biometricProcessorMode: parsedEnvironment.data.BIOMETRIC_PROCESSOR_MODE,
  biometricServiceUrl: parsedEnvironment.data.BIOMETRIC_SERVICE_URL,
  biometricServiceApiKey: parsedEnvironment.data.BIOMETRIC_SERVICE_API_KEY,
  biometricRequestTimeoutMs: parsedEnvironment.data.BIOMETRIC_REQUEST_TIMEOUT_MS,
  biometricMatchThreshold: parsedEnvironment.data.BIOMETRIC_MATCH_THRESHOLD,
  biometricLivenessThreshold: parsedEnvironment.data.BIOMETRIC_LIVENESS_THRESHOLD,
  redisUrl: parsedEnvironment.data.REDIS_URL,
  notificationQueueName: parsedEnvironment.data.NOTIFICATION_QUEUE_NAME,
  notificationWorkerConcurrency: parsedEnvironment.data.NOTIFICATION_WORKER_CONCURRENCY,
  notificationMaxAttempts: parsedEnvironment.data.NOTIFICATION_MAX_ATTEMPTS,
  notificationBackoffMs: parsedEnvironment.data.NOTIFICATION_BACKOFF_MS,
  notificationBatchMaxSize: parsedEnvironment.data.NOTIFICATION_BATCH_MAX_SIZE,
  notificationMaxDelayDays: parsedEnvironment.data.NOTIFICATION_MAX_DELAY_DAYS,
  smsProviderMode: parsedEnvironment.data.SMS_PROVIDER_MODE,
  smsSimulatedFailureMode: parsedEnvironment.data.SMS_SIMULATED_FAILURE_MODE,
  simgateApiKey: parsedEnvironment.data.SIMGATE_API_KEY,
  simgateDeviceId: parsedEnvironment.data.SIMGATE_DEVICE_ID,
  smsRequestTimeoutMs: parsedEnvironment.data.SMS_REQUEST_TIMEOUT_MS,
  emailProviderMode: parsedEnvironment.data.EMAIL_PROVIDER_MODE,
  brevoApiKey: parsedEnvironment.data.BREVO_API_KEY,
  brevoSenderEmail: parsedEnvironment.data.BREVO_SENDER_EMAIL,
  brevoSenderName: parsedEnvironment.data.BREVO_SENDER_NAME,
  gmailClientId: parsedEnvironment.data.GMAIL_CLIENT_ID,
  gmailClientSecret: parsedEnvironment.data.GMAIL_CLIENT_SECRET,
  gmailRefreshToken: parsedEnvironment.data.GMAIL_REFRESH_TOKEN,
  gmailSenderEmail: parsedEnvironment.data.GMAIL_SENDER_EMAIL,
  gmailSenderName: parsedEnvironment.data.GMAIL_SENDER_NAME,
  publicAppUrl: parsedEnvironment.data.PUBLIC_APP_URL.replace(/\/$/, ""),
  emailRequestTimeoutMs: parsedEnvironment.data.EMAIL_REQUEST_TIMEOUT_MS,
  distributionReminderLeadMinutes: parsedEnvironment.data.DISTRIBUTION_REMINDER_LEAD_MINUTES,
};
