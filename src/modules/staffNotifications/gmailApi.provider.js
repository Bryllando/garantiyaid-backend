import { env } from "../../config/env.js";
import { renderStaffEmail } from "./staffEmail.template.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanHeader(value) {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function encodedHeader(value) {
  return `=?UTF-8?B?${Buffer.from(cleanHeader(value), "utf8").toString("base64")}?=`;
}

function encodedBody(value) {
  // MIME base64 lines must be at most 76 characters, with CRLF text line endings.
  return Buffer.from(value.replace(/\r\n|\r|\n/g, "\r\n"), "utf8")
    .toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
}

async function jsonOrEmpty(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function failedResult(prefix, status, body = {}) {
  const reason = JSON.stringify(body);
  const retryable = status === 408
    || status === 429
    || status >= 500
    || /rateLimitExceeded|userRateLimitExceeded|backendError/i.test(reason);
  return {
    success: false,
    retryable,
    errorCode: `${prefix}_${retryable ? "TEMPORARY" : "REJECTED"}`,
  };
}

export function createGmailApiProvider({
  fetchImpl = globalThis.fetch,
  clientId = env.gmailClientId,
  clientSecret = env.gmailClientSecret,
  refreshToken = env.gmailRefreshToken,
  senderEmail = env.gmailSenderEmail,
  senderName = env.gmailSenderName,
  publicAppUrl = env.publicAppUrl,
  timeoutMs = env.emailRequestTimeoutMs,
} = {}) {
  return {
    async send({ notificationId, recipient, subject, message, targetPath, recipientName, occurredAt }) {
      if (![recipient, senderEmail].every((value) => EMAIL_PATTERN.test(value ?? ""))) {
        return { success: false, retryable: false, errorCode: "INVALID_EMAIL_ADDRESS" };
      }
      if (!clientId || !clientSecret || !refreshToken) {
        return { success: false, retryable: false, errorCode: "GMAIL_NOT_CONFIGURED" };
      }

      try {
        const tokenResponse = await fetchImpl(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const token = await jsonOrEmpty(tokenResponse);
        if (!tokenResponse.ok || !token.access_token) {
          return failedResult("GMAIL_TOKEN", tokenResponse.status, token);
        }

        const content = renderStaffEmail({ subject, message, targetPath, recipientName, occurredAt }, publicAppUrl);
        const safeSubject = content.subject;
        const boundary = `garantiyaid-${notificationId.replaceAll("-", "")}`;
        const raw = [
          `From: ${encodedHeader(senderName)} <${senderEmail}>`,
          `To: ${cleanHeader(recipient)}`,
          `Subject: ${encodedHeader(safeSubject)}`,
          `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
          `Message-ID: <${notificationId}@garantiyaid.local>`,
          `X-GarantiyAid-Notification-ID: ${notificationId}`,
          "MIME-Version: 1.0",
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          "",
          `--${boundary}`,
          'Content-Type: text/plain; charset="UTF-8"',
          "Content-Transfer-Encoding: base64",
          "",
          encodedBody(content.textContent),
          `--${boundary}`,
          'Content-Type: text/html; charset="UTF-8"',
          "Content-Transfer-Encoding: base64",
          "",
          encodedBody(content.htmlContent),
          `--${boundary}--`,
        ].join("\r\n");

        const sendResponse = await fetchImpl(SEND_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw: Buffer.from(raw, "utf8").toString("base64url") }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const sent = await jsonOrEmpty(sendResponse);
        if (!sendResponse.ok || !sent.id) return failedResult("GMAIL_SEND", sendResponse.status, sent);
        return { success: true, providerReference: sent.id };
      } catch (error) {
        return {
          success: false,
          retryable: true,
          errorCode: error?.name === "TimeoutError" ? "GMAIL_TIMEOUT" : "GMAIL_NETWORK_ERROR",
        };
      }
    },
  };
}

export const gmailApiProvider = createGmailApiProvider();
