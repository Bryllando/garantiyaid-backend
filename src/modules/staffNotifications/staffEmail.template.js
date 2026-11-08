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

export function renderStaffEmail({ subject, message, targetPath, recipientName, occurredAt }, publicAppUrl) {
  const safeSubject = cleanHeader(subject);
  const safeTargetPath = targetPath?.startsWith("/") && !targetPath.startsWith("//")
    ? targetPath
    : "/login";
  const appUrl = new URL(publicAppUrl);
  const requestedUrl = new URL(safeTargetPath, `${publicAppUrl}/`);
  const actionUrl = (requestedUrl.origin === appUrl.origin ? requestedUrl : new URL('/login', appUrl)).toString();
  const actionLabel = safeTargetPath.startsWith("/reset-password?token=") ? "Reset password"
    : safeTargetPath === "/account?section=password" ? "Review password settings"
    : safeTargetPath === "/account?section=authenticator" ? "Review authenticator settings"
      : "Sign in to GarantiyAid";
  const eventTime = occurredAt ? `${new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" }).format(new Date(occurredAt))} PHT` : null;
  const safeName = html(recipientName || "Staff member");
  const paragraphs = html(message).split(/\n\s*\n/).map((paragraph) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:#40516a">${paragraph.replaceAll("\n", "<br>")}</p>`).join("");
  const safeActionUrl = html(actionUrl);
  return {
    subject: safeSubject,
    textContent: [
      `Hello ${recipientName || "Staff member"},`,
      "",
      message,
      "",
      ...(eventTime ? [`Event time: ${eventTime}`, ""] : []),
      ...(targetPath !== null ? [`${actionLabel}: ${actionUrl}`, ""] : []),
      "",
      "Never share your password, verification codes, recovery codes, or password-reset link.",
      "Need help? Contact your office’s System Administrator.",
    ].join("\r\n"),
    htmlContent: `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${html(safeSubject)}</title></head>
<body style="margin:0;background:#f8fafc;font-family:Arial,sans-serif;color:#10213a">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc">
    <tr><td align="center" style="padding:28px 12px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;border:1px solid #dbe4ee;border-top:4px solid #06264d;background:#ffffff">
        <tr><td style="padding:24px 24px 20px;border-bottom:1px solid #dbe4ee">
          <p style="margin:0;font-size:20px;line-height:1.5;font-weight:700;color:#06264d">GarantiyAid</p>
          <p style="margin:3px 0 0;font-size:14px;line-height:1.5;color:#40516a">Staff account notice</p>
        </td></tr>
        <tr><td style="padding:28px 24px">
          <h1 style="margin:0 0 24px;font-size:24px;line-height:1.35;font-weight:700;color:#10213a">${html(safeSubject)}</h1>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.65">Hello ${safeName},</p>
          ${paragraphs}
          ${targetPath !== null ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0"><tr><td bgcolor="#0a5ca8" style="border-radius:4px"><a href="${safeActionUrl}" style="display:inline-block;border:1px solid #0a5ca8;padding:14px 22px;color:#ffffff;font-size:16px;line-height:1.5;font-weight:700;text-decoration:none">${actionLabel}</a></td></tr></table><p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#40516a">If the button does not open, copy this link into your browser:</p><p style="margin:0;font-size:13px;line-height:1.6;word-break:break-all;overflow-wrap:anywhere"><a href="${safeActionUrl}" style="color:#0a5ca8;text-decoration:underline">${safeActionUrl}</a></p>` : ""}
          ${eventTime ? `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #dbe4ee;font-size:13px;line-height:1.6;color:#40516a">Event time: ${html(eventTime)}</p>` : ""}
        </td></tr>
        <tr><td style="padding:20px 24px;border-top:1px solid #dbe4ee;background:#f8fafc">
          <p style="margin:0;font-size:14px;line-height:1.65;color:#40516a">Never share your password, verification codes, recovery codes, or password-reset link.</p>
          <p style="margin:10px 0 0;font-size:13px;line-height:1.6;color:#40516a">Need help? Contact your office’s System Administrator.</p>
          <p style="margin:14px 0 0;font-size:12px;line-height:1.6;color:#5f7087">Automated notice · GarantiyAid staff portal</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
  };
}
