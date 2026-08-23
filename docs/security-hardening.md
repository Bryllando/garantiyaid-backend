# GarantiyAid Backend Security Baseline

Last reviewed: 2026-08-12

This is the technical baseline for the current staff API. It is not a legal certification or a substitute for an agency Privacy Impact Assessment, Data Protection Officer review, independent penetration test, or production infrastructure review.

## Current security model

- Staff authentication uses password plus mandatory TOTP.
- New staff passwords require at least 12 characters and are bcrypt-hashed at cost 12. Inputs are limited to bcrypt's 72-byte boundary to prevent silent truncation.
- Access JWTs are short-lived, signed only with HS256, and verify issuer, audience, expiration, type, subject, and UUID `jti`.
- Every access JWT has a database-backed session. Logout, account deactivation, and role changes revoke sessions.
- Repeated password or TOTP failures temporarily lock the account. Authentication endpoints also have per-client rate limits.
- TOTP counters are stored after successful use, preventing reuse of the same or an older code.
- Authorization uses current database role and account state on every protected request. Barangay access is scoped by the staff account's barangay, not a client-submitted claim.
- Prisma parameterized queries, strict Zod schemas, UUID validation, business-state checks, transactions, Helmet, CORS allowlisting, body-size limits, secure file signatures, and audit logs are in place.
- Responses use request IDs and generic production errors. Production logs exclude request bodies, query strings, passwords, tokens, and TOTP secrets.

## Control assessment

Legend: **Implemented** means enforced in this backend; **Partial** needs deployment or more work; **N/A now** means the current architecture does not use that mechanism; **Deferred** must be implemented before the named future module.

| # | Control | Status | GarantiyAid decision |
|---:|---|---|---|
| 1 | Authentication | Implemented | Password + mandatory TOTP for all staff roles. |
| 2 | Authorization / RBAC | Implemented | Role middleware plus resource-level policies and Barangay scoping. |
| 3 | Rate limiting | Implemented / production action | Global API and stricter authentication limits. Replace the in-memory store with a shared production store when running multiple instances. |
| 4 | Input validation | Implemented | Strict Zod body/query/parameter schemas reject unknown and malformed input. |
| 5 | SQL injection protection | Implemented | Prisma query API is used; the static check blocks unsafe raw-query methods. |
| 6 | XSS protection | Implemented for JSON API | No HTML rendering; controlled JSON, MIME handling, and Helmet reduce browser interpretation risk. Frontend output encoding remains required. |
| 7 | CSRF protection | N/A now | Bearer tokens are sent in `Authorization`; no ambient cookie authentication. Reassess if auth moves to cookies. |
| 8 | CORS configuration | Implemented | Explicit origin allowlist, methods, headers, no credentialed cross-origin requests, no wildcard. |
| 9 | HTTPS / TLS | Deployment required | Production config fails unless HTTPS enforcement is enabled. TLS must terminate at the trusted reverse proxy/load balancer. |
| 10 | Secure cookies | N/A now | The API does not issue authentication cookies. If cookies are added: `Secure`, `HttpOnly`, `SameSite`, narrow path/domain, and CSRF tokens are mandatory. |
| 11 | Secure JWT handling | Implemented | HS256 allowlist, strong secret, issuer/audience/type/sub/jti/expiry validation, 15-minute default, DB session lookup. |
| 12 | Password hashing | Implemented | bcrypt cost 12; no plaintext storage or response exposure. Argon2id is a future migration option, not required to keep current hashes safe. |
| 13 | MFA / TOTP | Implemented | Encrypted TOTP secrets, setup token, verification window, and replay prevention. Recovery/reset needs a documented offline identity process. |
| 14 | Account lockout / login throttling | Implemented | Failure window, temporary lock, per-client throttling, generic credential errors, lock audit event. |
| 15 | Session management | Implemented | Server-side session records support revocation and expiry. |
| 16 | Refresh token rotation | N/A now | No refresh tokens exist. Staff re-authenticate after the short access token expires. Implement rotation only if refresh tokens are introduced. |
| 17 | Security headers / Helmet | Implemented | Helmet, no `X-Powered-By`, no-store responses, request IDs; HSTS is production-only. |
| 18 | File upload security | Partial | Auth/RBAC, 5 MB limit, UUID filenames, magic-byte allowlist, protected non-public storage, path traversal protection. Add malware scanning/CDR before production. |
| 19 | Secrets / environment protection | Implemented / operations | `.env` ignored, `.env.example` sanitized, production secret validation. Store production secrets in a managed secret manager and rotate them. |
| 20 | Database access control | Implemented locally | `garantiyaid_system` is not superuser and cannot create DBs, roles, or replication. Split migration and runtime roles in production. |
| 21 | Database encryption | Partial | TOTP secrets use AES-256-GCM. Production DB/storage encryption is an infrastructure requirement. |
| 22 | Database transactions | Implemented | Multi-record business and audit changes use transactions; critical overlap checks use serializable isolation. |
| 23 | Database backups | Operations required | Encrypted automatic backups, separate account/location, retention, alerting, and restore tests are mandatory. |
| 24 | Least-privilege access | Implemented / ongoing | Scoped roles, protected last admin, no self role/deactivation. Review DB/cloud/service privileges quarterly. |
| 25 | API endpoint protection | Implemented | Default protected route surfaces; health is intentionally public and minimal. |
| 26 | API request size limits | Implemented | JSON 1 MB, beneficiary documents 5 MB, one uploaded file, safe 413 errors. |
| 27 | Error handling / leakage prevention | Implemented | Generic 500 responses, sanitized upload/parser errors, request IDs, no production stack traces. |
| 28 | Audit logging | Implemented | Staff/security/business actions logged; protected read API with recursive redaction. Logs must be exported to immutable centralized storage in production. |
| 29 | Business logic validation | Implemented for current modules | Program, document, enrollment, distribution and distribution-slot transitions and cross-entity rules are server-enforced. |
| 30 | IDOR / BOLA protection | Implemented for current modules | UUID parsing plus ownership/Barangay/role checks on resource reads and mutations. Add equivalent policies to every new module. |
| 31 | UUID / unpredictable IDs | Implemented | Public resource IDs and session IDs are UUIDs generated server-side. |
| 32 | Replay attack protection | Partial | TOTP one-time counters, short JWTs, jti sessions. Add idempotency to high-impact create/claim/payment mutations. |
| 33 | QR expiration and one-time use | Deferred | Must be designed with hashed random tokens, purpose/audience, short expiry, atomic one-time consumption, and scan logs before QR work starts. |
| 34 | Idempotency protection | Deferred before claims | Enrollment uniqueness already blocks duplicates. Add an idempotency-key store before allocation, claim, payout, or external-notification mutations. |
| 35 | Dependency vulnerability scanning | Implemented | `npm run security:audit`; current audit reports zero known vulnerabilities. |
| 36 | Secure dependency management | Implemented | Lockfile, minimum supported Node version, patched rate limiter, exact transitive security override, weekly Dependabot config. |
| 37 | Security testing | Implemented / ongoing | Automated authentication, headers, CORS, input, rate, privacy, RBAC, BOLA, file, slot, and workflow tests. |
| 38 | SAST | Partial | `npm run security:static` blocks obvious secret/unsafe-query/dynamic-execution patterns. Add Semgrep or CodeQL in a real repository for broader coverage. |
| 39 | DAST | Deployment required | Run OWASP ZAP authenticated scans against staging, never directly against production records. |
| 40 | Penetration testing | External required | Independent test before production and after material auth/claim/payment changes. |
| 41 | Brute-force protection | Implemented | Constant-cost unknown-user password check, client rate limit, account-based lockout, MFA. |
| 42 | Bot protection | Infrastructure required | Use WAF/bot controls at the edge; do not rely only on application rate limiting. |
| 43 | IP blocking / allowlisting | Deployment decision | Consider VPN/agency-network allowlists for admin endpoints, with documented emergency access. Avoid hardcoding office IPs in application code. |
| 44 | Request logging / monitoring | Implemented baseline | Structured production request/security logs exclude bodies and query strings. Forward to SIEM with restricted access and retention. |
| 45 | Security alerts | Operations required | Alert on repeated locks, abnormal 401/403/429 rates, admin role changes, disabled accounts, and audit export failures. |
| 46 | Intrusion detection | Infrastructure required | Cloud/network/host IDS or managed detection belongs outside Express. |
| 47 | WAF | Infrastructure required | Deploy a managed WAF with tested rules and an exception process. |
| 48 | DDoS protection | Infrastructure required | CDN/load balancer/provider protection, autoscaling limits, upstream rate controls, and runbooks. |
| 49 | Secure file/object storage | Partial | Current files are protected outside public webroot. Production should use private encrypted object storage, short signed downloads, malware quarantine, and lifecycle policy. |
| 50 | Production debug disabled | Implemented | Production errors/logs omit stack details; config distinguishes production. Do not run `npm run dev` in production. |
| 51 | Secure error messages | Implemented | Stable codes and generic user messages; detailed validation is limited to submitted field names. |
| 52 | Secure configuration management | Implemented baseline | Production fail-closed validation for required secrets, HTTPS, CORS, and JWT lifetime. Use immutable reviewed deployment configuration. |
| 53 | Git secret scanning | Partial | Static check rejects JWT/private-key patterns and `.env.example` junk. Enable repository push protection and historical secret scanning once hosted in Git. |
| 54 | CI/CD security checks | Prepared | GitHub workflow runs clean install, generation, tests, schema validation, static scan, and dependency audit with read-only permissions. |
| 55 | Dependency updates / patching | Prepared / ongoing | Weekly Dependabot config plus audit gate. Review updates, test them, and patch critical/high findings under an agency SLA. |
| 56 | Role and permission auditing | Implemented / procedural | Role/account changes are logged and protected. Export a quarterly active-user/role/Barangay access review signed by an owner. |
| 57 | Data encryption at rest | Infrastructure required | Enable encrypted DB volumes/backups/object storage with managed keys; keep TOTP application-field encryption. |
| 58 | Data encryption in transit | Deployment required | HTTPS is enforced in production; require verified TLS for PostgreSQL and all downstream services. |
| 59 | Personal data protection | Partial / governance required | Data minimization in selects, redaction, scoped access, encrypted TOTP, and audit trails exist. Complete a PIA, privacy notice, lawful-basis and data-sharing review. |
| 60 | Data retention / secure deletion | Governance + implementation required | Define record-specific retention with the DPO/records officer before building deletion jobs; preserve National Archives/legal obligations. |
| 61 | Backup recovery testing | Operations required | Perform scheduled restore drills and record achieved RPO/RTO; a backup is not verified until restored. |
| 62 | Disaster recovery plan | Operations required | Define alternate region/site, dependencies, owners, RPO/RTO, communication, and annual exercises. |
| 63 | Incident response | Operations required | Named incident commander, containment, evidence preservation, DPO/legal notification assessment, recovery, and lessons learned. |
| 64 | Admin activity monitoring | Implemented baseline | Admin login/logout, account/role, Barangay, distribution and other business actions are auditable; SIEM alerts remain required. |
| 65 | Privileged account protection | Implemented baseline | MFA, short revocable sessions, lockout, no self privilege change, last-admin protection. Add separate named admin accounts and prohibit shared credentials. |

## Production deployment gate

Do not expose the API publicly until all items below are complete:

1. Set `NODE_ENV=production`, `ENFORCE_HTTPS=true`, exact HTTPS `CORS_ORIGIN` values, a 64+ character random JWT secret, and an exact trusted proxy hop count.
2. Ensure the Node process is reachable only from the named reverse proxy. A wrong `TRUST_PROXY_HOPS` setting can make client IP controls unreliable.
3. Terminate TLS 1.2+ at the proxy/load balancer and use a verified TLS PostgreSQL connection. Localhost currently does not use database TLS.
4. Use a runtime DB role restricted to required CRUD operations; use a different controlled role for migrations.
5. Replace the in-memory rate-limit store with Redis or another shared store before running multiple API instances.
6. Store `JWT_ACCESS_SECRET`, `FIELD_ENCRYPTION_KEY`, database credentials, and backup keys in a managed secret service. Rotate any secret exposed to logs, chat, source, screenshots, or tickets.
7. Move documents to private encrypted object storage with quarantine, antivirus scanning, lifecycle retention, and audited download authorization.
8. Centralize append-only request, security, and audit logs; restrict access; alert on suspicious authentication and privileged changes.
9. Configure WAF, DDoS protection, host/network monitoring, backup policy, restore drills, and incident/disaster runbooks.
10. Complete an agency Privacy Impact Assessment, retention schedule, data-sharing review, security clearance/access process, and independent penetration test.

## Verification commands

```powershell
npm.cmd run security:check
npm.cmd run verify:workflow
npm.cmd run verify:distribution
```

For manual Postman testing after this change, restart the API and log in again. Old tokens intentionally fail because they have no registered session. Test logout with:

```text
POST {{baseUrl}}/auth/logout
Authorization: Bearer {{adminToken}}
```

The same token must then return `401 INVALID_SESSION` on `GET {{baseUrl}}/auth/me`.

## Reference baseline

- Philippine Data Privacy Act of 2012: https://privacy.gov.ph/data-privacy-act/
- NPC Circular 16-01, Security of Personal Data in Government Agencies: https://privacy.gov.ph/npc-circular-16-01-security-of-personal-data-in-government-agencies/
- OWASP ASVS 5.0: https://owasp.org/www-project-application-security-verification-standard/
- OWASP REST Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html
- OWASP Authentication Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- NIST SP 800-63B-4: https://csrc.nist.gov/pubs/sp/800/63/b/4/final
