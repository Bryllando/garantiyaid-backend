# Gmail security email

GarantiyAid uses Gmail as a staff notification channel. Gmail does not approve government actions, prove identity, replace the audit log, or become a login method. PostgreSQL remains the official record; Gmail tells the affected staff member that a security event happened.

## Implemented events

| Event | Email purpose |
| --- | --- |
| Administrator creates a staff account | Sends the permanent Staff ID and first-sign-in steps. The temporary password stays in the secure handoff dialog and is never emailed. |
| Staff changes the initial or current password | Confirms the password change and warns the staff member to report an unexpected change. |
| Staff enables or replaces an authenticator | Confirms the authenticator change without sending a TOTP secret, QR value, code, or recovery code. |
| Administrator resets an authenticator | Warns the staff member that the authenticator and active sessions were reset. |
| Administrator deactivates or reactivates an account | Confirms the account-status change. |

Each event writes an in-app notification and email delivery record in the same database transaction as the account change. The Notification Worker then sends the Gmail message asynchronously through HTTPS. A temporary Gmail or Redis failure does not reverse the completed account action. Jobs have a stable ID, bounded exponential retries, a database processing lock, and a final audited `SENT` or `FAILED` state.

## Free Gmail setup for the capstone

This implementation uses the Gmail API because Railway blocks outbound SMTP on Free, Trial, and Hobby plans. A personal Gmail sender works for a low-volume capstone demonstration without a per-message SMS-style fee, subject to Google API quotas and normal Gmail sending limits.

1. Create a dedicated sender such as `garantiyaid.notifications@gmail.com`. Enable two-step verification and protect its recovery options.
2. Open [Google Cloud Console](https://console.cloud.google.com/), create a project, and enable **Gmail API**.
3. Configure the OAuth consent screen as **External**, add the sender address as a test user, and request only `https://www.googleapis.com/auth/gmail.send`.
4. Create an OAuth 2.0 client. In [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/), open Settings, enable **Use your own OAuth credentials**, enter that client ID and secret, authorize the `gmail.send` scope, exchange the code, and copy the refresh token.
5. In the Railway environment shared by both the **API** and **Notification Worker**, set:

   ```env
   EMAIL_PROVIDER_MODE=GMAIL_API
   GMAIL_CLIENT_ID=your-google-oauth-client-id
   GMAIL_CLIENT_SECRET=your-google-oauth-client-secret
   GMAIL_REFRESH_TOKEN=your-google-oauth-refresh-token
   GMAIL_SENDER_EMAIL=garantiyaid.notifications@gmail.com
   GMAIL_SENDER_NAME=GarantiyAid Security
   PUBLIC_APP_URL=https://your-vercel-domain.vercel.app
   EMAIL_REQUEST_TIMEOUT_MS=10000
   ```

6. Keep the existing `REDIS_URL` available to the API and Notification Worker. Set the API service's Railway pre-deploy command to `npx prisma migrate deploy`, then redeploy the API and Notification Worker.
7. Create a test staff account using an email you can open. The handoff dialog should say **Email queued**. Record the credentials privately and acknowledge the handoff before closing. Open that staff member's **Email history** and use **Refresh status** to check the result. Check the recipient Inbox and Spam folder, then change that test account's password and authenticator to verify the security alerts.

Vercel does not need Gmail credentials. It only hosts the frontend and must keep its API base URL pointed at the Railway API. Keep all `GMAIL_*` values in Railway server variables; never put them in a `VITE_*` variable or commit them to Git.

OAuth apps left in **Testing** can issue refresh tokens that expire after seven days for Gmail scopes. That is acceptable for a short demo if the token is renewed. For a stable deployment, publish the OAuth app and complete any Google verification it requires, or later use an organization-managed Google Workspace account with an internal OAuth app.

## Staff workflow

1. The administrator creates the staff record and receives the one-time handoff dialog.
2. The system queues an email containing the Staff ID and setup instructions.
3. The administrator gives the temporary password through the office's approved private channel.
4. The staff member signs in, creates a private password, connects an authenticator, and saves the recovery codes offline.
5. Later password, authenticator, and account-status changes produce both an in-app notice and a Gmail security alert.

The official email in **Account settings → Personal details** is the destination for future alerts. Staff sign in with their Staff ID or approved username; email is not used as an access credential.

## Check delivery

- System Administrators: open **Staff and barangays**, find the account, then select **Email history**. This shows the latest 20 security emails and their event and delivery times in PHT. Use **Refresh status** after a queued message has had time to send.
- Staff: open the notification bell to see the email status beside their own security notices. The open panel refreshes every 15 seconds.
- **Email queued** means waiting to send. **Email sent** means Gmail accepted the message; it does not confirm Inbox placement or that the recipient read it. **Email failed** means sending stopped; the account change was still saved. **Email notifications are off** means email was disabled for that event.
- Password and authenticator email links return to the relevant account settings after sign-in, including authenticator verification. Deactivation emails explain who to contact without offering a sign-in button.

Run `npm run verify:email-ui` in `garantiyaid-frontend` for the isolated browser checks (Microsoft Edge by default, or set `PLAYWRIGHT_CHANNEL` to an installed supported browser). Requests use fixtures and no real email is sent. This does not replace checking the actual Gmail mobile app, dark mode, or Inbox placement.
