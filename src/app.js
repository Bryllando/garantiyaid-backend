import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFound } from "./middleware/notFound.js";
import { apiRateLimiter } from "./middleware/rateLimit.js";
import {
  attachRequestContext,
  enforceHttps,
  logCompletedRequest,
  requireSupportedContentType,
} from "./middleware/security.js";
import apiRoutes from "./routes/index.js";

const app = express();

app.disable("x-powered-by");
if (env.trustProxyHops > 0) {
  app.set("trust proxy", env.trustProxyHops);
}

app.use(attachRequestContext);
app.use(logCompletedRequest);
if (env.enforceHttps) {
  app.use(enforceHttps);
}
app.use(helmet({
  crossOriginResourcePolicy: { policy: "same-site" },
  strictTransportSecurity: env.nodeEnv === "production" ? undefined : false,
}));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || env.corsOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(Object.assign(new Error("Origin is not allowed by CORS."), {
        statusCode: 403,
        code: "CORS_ORIGIN_DENIED",
      }));
    },
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "Idempotency-Key",
      "X-Chatbot-Session-Token",
    ],
    exposedHeaders: [
      "X-Request-Id",
      "RateLimit",
      "RateLimit-Policy",
      "Retry-After",
      "Idempotency-Replayed",
    ],
    credentials: false,
    maxAge: 600,
  }),
);
app.use(requireSupportedContentType);
app.use(express.json({ limit: "1mb" }));
app.use(apiRateLimiter);

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      service: "garantiyaid-backend",
      version: "v1",
    },
  });
});

app.use("/api/v1", apiRoutes);
app.use(notFound);
app.use(errorHandler);

export default app;
