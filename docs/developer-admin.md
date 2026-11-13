# Local Developer Admin

This opt-in developer account uses the existing Username and Password form to enter the SYSTEM_ADMIN workspace without a manual TOTP step. It uses normal JWT sessions, permissions, audit records and logout. It does not grant Barangay/DSWD-only actions or bypass independent review. Keep testing normal authentication separately.

## Setup

Use only the local demo database. In backend `.env`, explicitly set:

```dotenv
NODE_ENV=development
DEV_QUICK_LOGIN_ENABLED=true
DEV_ADMIN_DATABASE=your_exact_local_demo_database_name
DEV_ADMIN_PASSWORD=your_local_developer_password
TRUST_PROXY_HOPS=0
```

The existing DEV_QUICK_LOGIN_ENABLED flag now controls only the developer account's local TOTP exception; there is no passwordless endpoint or additional login button. The database name must match the pathname in the local PostgreSQL DATABASE_URL. Never use a production database, remote tunnel or public proxy. CORS origins must all be local addresses. The API binds to 127.0.0.1 while enabled. Passwords belong only in the ignored `.env`; the setup stores a bcrypt hash. No email/SMS is sent by provisioning or login.

From the backend folder, run `npm.cmd run dev:admin:setup`. This creates employee ID `DEV-ADMIN`, internal username `dev.admin` (following the existing username rules), display name `Developer Admin`, and role `SYSTEM_ADMIN`. Sign in with DEV-ADMIN as requested. The actual database userId remains a UUID. Repeating setup preserves the account, password, MFA and status; conflicting or inactive records are not overwritten or reactivated.

Restart the existing backend terminal, then open the frontend with `npm.cmd run dev` at localhost. Enter **DEV-ADMIN** in Username and the configured developer password in Password, then choose **Sign in securely** or press Enter. Only this dedicated account skips manual TOTP in the permitted local environment and opens `/dashboard`.

The form has exactly the existing Username and Password inputs. It contains no additional developer panel, shortcut button, prefilled credentials or separate developer API calls. Existing staff still follow password setup, TOTP enrollment and verification normally. A developer session is visibly labeled **Admin workspace · Local dev**. Sensitive account changes retain their existing reauthentication requirements.

## Disable and deploy

Set DEV_QUICK_LOGIN_ENABLED=false and restart the API. Existing developer tokens and DEV-ADMIN credential login are rejected on authenticated HTTP and realtime connections. Set this flag false or omit it on deployment. Startup refuses an enabled flag outside development or with non-local/mismatched database settings. The removed `/auth/dev-admin` and `/auth/dev-admin/login` endpoints return 404 even when local developer login is enabled.

Do not expose the dev server through port forwarding, tunnels or an untrusted local proxy. This feature trusts access to the developer's machine; it is not a shared-environment login method.

`npm.cmd test` explicitly disables quick login before loading unrelated tests. Its dedicated tests opt in with isolated fixtures. For a focused direct Node test run, include `--import ./scripts/test-environment.js` before `--test`.
