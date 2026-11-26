import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";

import { createSimgateSmsProvider } from "../notifications/simgateSms.provider.js";

export function mobileSmsConfigured() {
  return Boolean(env.mobileSmsSemaphoreApiKey || (env.smsProviderMode === "SIMGATE" && env.simgateApiKey && env.simgateDeviceId));
}

export async function sendMobileOtpSms(contactNumber, code) {
  if (env.mobileAuthMode !== "SMS" || !mobileSmsConfigured()) {
    throw new AppError(503, "MOBILE_AUTH_UNAVAILABLE", "SMS verification is not configured.");
  }
  if (!/^\+639\d{9}$/.test(contactNumber) || !/^\d{6}$/.test(code)) throw new Error("Invalid internal OTP delivery request");
  const number = contactNumber.slice(1);
  const message = `GarantiyAid verification code: ${code}. Expires in 5 minutes. Keep this code private.`;
  if (!env.mobileSmsSemaphoreApiKey) {
    const result = await createSimgateSmsProvider().send({ recipient: contactNumber, message });
    if (!result.success) throw new AppError(503, "OTP_DELIVERY_FAILED", "The phone gateway could not confirm acceptance. Request a new code after one minute.");
    return;
  }
  const body = new URLSearchParams({ apikey: env.mobileSmsSemaphoreApiKey, number, message });
  if (env.mobileSmsSenderName) body.set("sendername", env.mobileSmsSenderName);
  try {
    const response = await fetch("https://api.semaphore.co/api/v4/messages", {
      method: "POST", body, redirect: "error", signal: AbortSignal.timeout(env.mobileSmsTimeoutMs),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!response.ok) throw new Error("SMS gateway rejected request");
    const result = await response.json();
    const entry = Array.isArray(result) && result.length === 1 ? result[0] : null;
    if (!entry?.message_id || !["queued", "pending", "sent"].includes(String(entry.status).toLowerCase())
      || String(entry.recipient).replace(/^\+/, "") !== number || !String(entry.message).includes(code)) {
      throw new Error("SMS gateway did not accept the code");
    }
    // The gateway response includes the raw code and recipient; never return or log it.
  } catch {
    throw new AppError(503, "OTP_DELIVERY_FAILED", "The verification text could not be sent. Wait one minute, then request a new code.");
  }
}
