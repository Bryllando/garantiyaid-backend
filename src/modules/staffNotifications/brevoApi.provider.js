import { env } from "../../config/env.js";
import { renderStaffEmail } from "./staffEmail.template.js";

const SEND_URL = "https://api.brevo.com/v3/smtp/email";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createBrevoApiProvider({
  fetchImpl = globalThis.fetch,
  apiKey = env.brevoApiKey,
  senderEmail = env.brevoSenderEmail,
  senderName = env.brevoSenderName,
  publicAppUrl = env.publicAppUrl,
  timeoutMs = env.emailRequestTimeoutMs,
} = {}) {
  return {
    async send({ notificationId, recipient, ...message }) {
      if (![recipient, senderEmail].every((value) => EMAIL_PATTERN.test(value ?? ""))) {
        return { success: false, retryable: false, errorCode: "INVALID_EMAIL_ADDRESS" };
      }
      if (!apiKey) return { success: false, retryable: false, errorCode: "BREVO_NOT_CONFIGURED" };

      try {
        const content = renderStaffEmail(message, publicAppUrl);
        const response = await fetchImpl(SEND_URL, {
          method: "POST",
          headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            sender: { name: senderName, email: senderEmail },
            to: [{ email: recipient }],
            subject: content.subject,
            htmlContent: content.htmlContent,
            // Brevo deduplicates retries for 15 minutes using the notification's stable ID.
            headers: { IdempotencyKey: notificationId },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const sent = await response.json().catch(() => ({}));
        if (!response.ok) {
          return {
            success: false,
            retryable: response.status === 408 || response.status === 429 || response.status >= 500,
            errorCode: `BREVO_SEND_${response.status}`,
          };
        }
        if (typeof sent?.messageId !== "string" || !sent.messageId || sent.messageId.length > 120) {
          return { success: false, retryable: false, errorCode: "BREVO_RESPONSE_INVALID" };
        }
        return { success: true, providerReference: sent.messageId };
      } catch (error) {
        return {
          success: false,
          retryable: true,
          errorCode: error?.name === "TimeoutError" ? "BREVO_TIMEOUT" : "BREVO_NETWORK_ERROR",
        };
      }
    },
  };
}

export const brevoApiProvider = createBrevoApiProvider();
