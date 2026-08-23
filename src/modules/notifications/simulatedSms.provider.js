import { createHash } from "node:crypto";
import { env } from "../../config/env.js";

export const SIMULATED_SMS_DISCLOSURE = "Simulation only; no real SMS was sent.";

export function normalizePhilippineMobileNumber(value) {
  if (typeof value !== "string") return null;
  const compact = value.trim().replace(/[\s()-]/g, "");
  if (/^09\d{9}$/.test(compact)) return `+63${compact.slice(1)}`;
  if (/^\+639\d{9}$/.test(compact)) return compact;
  return null;
}

export function simulatedProviderReference(notificationId) {
  const digest = createHash("sha256")
    .update(`garantiyaid-simulated-sms:${notificationId}`)
    .digest("hex")
    .slice(0, 24);
  return `sim_${digest}`;
}

export function createSimulatedSmsProvider({ failureMode = env.smsSimulatedFailureMode } = {}) {
  return Object.freeze({
    mode: "SIMULATED",
    async send({ notificationId, recipient, message }) {
      const normalizedRecipient = normalizePhilippineMobileNumber(recipient);
      if (!normalizedRecipient) {
        return {
          success: false,
          simulated: true,
          retryable: false,
          errorCode: recipient ? "INVALID_RECIPIENT" : "MISSING_RECIPIENT",
          disclosure: SIMULATED_SMS_DISCLOSURE,
        };
      }
      if (typeof message !== "string" || message.length === 0 || message.length > 320) {
        return {
          success: false,
          simulated: true,
          retryable: false,
          errorCode: "INVALID_MESSAGE",
          disclosure: SIMULATED_SMS_DISCLOSURE,
        };
      }
      if (failureMode === "ALWAYS_FAIL") {
        return {
          success: false,
          simulated: true,
          retryable: true,
          errorCode: "SIMULATED_PROVIDER_FAILURE",
          disclosure: SIMULATED_SMS_DISCLOSURE,
        };
      }
      return {
        success: true,
        simulated: true,
        retryable: false,
        providerReference: simulatedProviderReference(notificationId),
        disclosure: SIMULATED_SMS_DISCLOSURE,
      };
    },
  });
}

export const simulatedSmsProvider = createSimulatedSmsProvider();
