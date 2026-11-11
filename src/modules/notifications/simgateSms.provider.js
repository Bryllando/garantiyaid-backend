import { env } from "../../config/env.js";
import { normalizePhilippineMobileNumber } from "./simulatedSms.provider.js";

export function createSimgateSmsProvider({
  fetchImpl = globalThis.fetch,
  apiKey = env.simgateApiKey,
  deviceId = env.simgateDeviceId,
  timeoutMs = env.smsRequestTimeoutMs,
} = {}) {
  const failure = (errorCode) => ({ success: false, simulated: false, retryable: false, errorCode });
  return {
    mode: "SIMGATE",
    async send({ recipient, message }) {
      const phoneNumber = normalizePhilippineMobileNumber(recipient);
      if (!phoneNumber) return failure(recipient ? "INVALID_RECIPIENT" : "MISSING_RECIPIENT");
      if (typeof message !== "string" || !message.trim() || message.length > 320) return failure("INVALID_MESSAGE");
      if (!apiKey || !deviceId) return failure("SIMGATE_NOT_CONFIGURED");
      try {
        const response = await fetchImpl("https://api.simgate.app/v1/sms/send", {
          method: "POST",
          headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ deviceId, phoneNumber, message }),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if ([400, 401, 403, 404, 422, 429].includes(response.status)) return failure(`SIMGATE_SEND_${response.status}`);
        const body = await response.json().catch(() => null);
        if ([200, 202].includes(response.status) && body?.success === true
          && typeof body.messageId === "string" && /^[A-Za-z0-9._-]{1,120}$/.test(body.messageId)
          && typeof body.queued === "boolean") {
          return { success: true, simulated: false, retryable: false, providerReference: body.messageId };
        }
        // No documented idempotency guarantee: an uncertain response must not trigger a second SMS.
        return failure("SIMGATE_DELIVERY_UNCONFIRMED");
      } catch {
        return failure("SIMGATE_DELIVERY_UNCONFIRMED");
      }
    },
  };
}

export const simgateSmsProvider = createSimgateSmsProvider();
