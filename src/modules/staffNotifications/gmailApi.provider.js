import { env } from "../../config/env.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanHeader(value) {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function html(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

        const safeSubject = cleanHeader(subject);
        const safeTargetPath = targetPath?.startsWith("/") && !targetPath.startsWith("//")
          ? targetPath
          : "/login";
        const appUrl = new URL(publicAppUrl);
        const requestedUrl = new URL(safeTargetPath, `${publicAppUrl}/`);
        const actionUrl = (requestedUrl.origin === appUrl.origin ? requestedUrl : new URL('/login', appUrl)).toString();
        const actionLabel = safeTargetPath.startsWith("/reset-password?token=") ? "Reset staff password"
          : safeTargetPath === "/account?section=password" ? "Review password settings"
          : safeTargetPath === "/account?section=authenticator" ? "Review authenticator settings"
            : "Sign in to GarantiyAid";
        const eventTime = occurredAt ? `${new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" }).format(new Date(occurredAt))} PHT` : null;
        const safeName = html(recipientName || "Staff member");
        const safeMessage = html(message);
        const safeActionUrl = html(actionUrl);
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
          encodedBody([
            `Hello ${recipientName || "Staff member"},`,
            "",
            message,
            "",
            ...(eventTime ? [`Event time: ${eventTime}`, ""] : []),
            ...(targetPath !== null ? [`${actionLabel}: ${actionUrl}`, ""] : []),
            "",
            "Never share your password, verification codes, or recovery codes.",
          ].join("\r\n")),
          `--${boundary}`,
          'Content-Type: text/html; charset="UTF-8"',
          "Content-Transfer-Encoding: base64",
          "",
          encodedBody(`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#f3f7fb;font-family:Arial,sans-serif;color:#14243b"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f7fb;padding:24px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border:1px solid #d9e3ef;border-radius:16px;overflow:hidden"><tr><td style="background:#0b2d52;padding:24px 28px;color:#fff"><div style="font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#b9d7ff">GarantiyAid</div><h1 style="margin:8px 0 0;font-size:22px;line-height:1.35;font-weight:700">${html(safeSubject)}</h1></td></tr><tr><td style="padding:28px"><p style="margin:0 0 16px;font-size:16px;line-height:1.6">Hello ${safeName},</p><p style="margin:0;font-size:16px;line-height:1.7;color:#44566c;white-space:pre-line;overflow-wrap:break-word">${safeMessage}</p>${eventTime ? `<p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#64748b">Event time: ${html(eventTime)}</p>` : ""}${targetPath !== null ? `<p style="margin:24px 0"><a href="${safeActionUrl}" style="display:inline-block;background:#245aa5;color:#fff;text-decoration:none;font-size:16px;line-height:1.4;font-weight:700;padding:13px 20px;border-radius:6px">${actionLabel}</a></p>` : ""}<div style="border:1px solid #bfdbfe;background:#eff6ff;border-radius:10px;margin-top:24px;padding:14px 16px;font-size:13px;line-height:1.6;color:#334155"><strong>Security reminder:</strong> Never share your password, verification codes, or recovery codes.</div></td></tr><tr><td style="border-top:1px solid #e2e8f0;padding:18px 28px;font-size:12px;line-height:1.6;color:#64748b">Automated account security notice from the GarantiyAid Staff Operations Portal.</td></tr></table></td></tr></table></body></html>`),
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
