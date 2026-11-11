import jwt from "jsonwebtoken";
import { createPublicKey } from "node:crypto";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";

export function verifyMobileAccessToken(token) {
  if (!env.mobileAuthPublicKey) {
    throw new AppError(503, "MOBILE_AUTH_NOT_CONFIGURED", "Mobile account integration has not been configured.");
  }
  try {
    const key = createPublicKey(env.mobileAuthPublicKey);
    if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error("Invalid verification key");
    const payload = jwt.verify(token, key, {
      algorithms: ["RS256"], issuer: env.mobileAuthIssuer, audience: env.mobileAuthAudience,
      maxAge: "15m", clockTolerance: 30,
    });
    if (payload.type !== "beneficiary" || typeof payload.sub !== "string"
      || !/^[^\s\x00-\x1f\x7f]{1,200}$/.test(payload.sub)
      || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)
      || payload.exp <= payload.iat || payload.exp - payload.iat > 900
      || payload.iat > Math.floor(Date.now() / 1000) + 30) throw new Error("Invalid mobile identity");
    return { issuer: payload.iss, subject: payload.sub };
  } catch {
    throw new AppError(401, "INVALID_MOBILE_TOKEN", "Sign in again through the beneficiary mobile app.");
  }
}

export function authenticateMobile(req, _res, next) {
  try {
    const [scheme, token, extra] = req.get("authorization")?.split(" ") ?? [];
    if (scheme !== "Bearer" || !token || extra) throw new AppError(401, "MOBILE_AUTH_REQUIRED", "Sign in through the beneficiary mobile app.");
    req.mobileIdentity = verifyMobileAccessToken(token);
    next();
  } catch (error) { next(error); }
}
