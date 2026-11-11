# Beneficiary mobile account linking

One person has one canonical `Beneficiary.beneficiaryId`. Existing web/import records are reused. A mobile login is a separate identity, linked only after staff verify account ownership and supporting records. Linking does not create a person, merge records, overwrite documents, enroll in a program, or pass biometric/claim verification.

## Staff workflow

Open **Beneficiaries → Mobile account requests** as Admin or Barangay Facilitator. A facilitator sees only their assigned barangay. DSWD can read the connection on the beneficiary record but cannot approve account links.

1. Choose a request and compare its submitted name and birth date with the existing record. Search other spellings if necessary; imported beneficiaries are included.
2. Confirm the person and account ownership against supporting evidence. A shared name or phone number alone is insufficient.
3. Choose the correct record, select **Review account link**, confirm identity, and record the evidence checked. The database permits one linked account per beneficiary and one request per trusted mobile identity.
4. If details are wrong, choose **Request correction** and write a reason. The mobile app reads that reason and resubmits the corrected request with its latest revision.
5. If no beneficiary exists, first search and use the existing registration/import workflow to create one verified record, then refresh and link it. Never create another person to get around an occupied mobile-account link.

The reviewer, reason, target beneficiary, time, and request revision are audit logged. Conflicting/stale decisions fail with 409; refresh before deciding again. Approved links cannot be reassigned through these endpoints. Account recovery or a suspected incorrect link must go to the administrator for investigation; there is no silent unlink/merge shortcut.

## Mobile backend connection

The mobile app is not in this repository. These endpoints are ready for its integration; no live mobile provider is assumed or enabled automatically.

Configure the API with the mobile backend's **RSA public key** in `MOBILE_AUTH_PUBLIC_KEY`, plus matching `MOBILE_AUTH_ISSUER` and `MOBILE_AUTH_AUDIENCE`. The private signing key stays on the trusted mobile backend. Never bundle it or the staff JWT secret in the mobile app.

After authenticating a real mobile user, that trusted backend issues an **RS256** bearer assertion:

```json
{
  "iss": "garantiyaid-mobile",
  "aud": "garantiyaid-beneficiary-api",
  "sub": "stable-user-id-from-your-mobile-backend",
  "type": "beneficiary",
  "iat": 1794182400,
  "exp": 1794183000
}
```

Use current timestamps, at most 15 minutes lifetime, RSA keys of at least 2048 bits, HTTPS outside local development, and a subject that does not change when email/phone changes. The API verifies signature, algorithm, issuer, audience, type, expiry, and subject. A client-supplied account ID, beneficiary ID, email, or phone number never authorizes a link. A mobile assertion does not authorize staff APIs. Without a configured key, the mobile endpoints return `503 MOBILE_AUTH_NOT_CONFIGURED`.

If your mobile app uses Firebase, Supabase, or another identity provider, exchange its verified identity on **your trusted backend** for this assertion. Do not send an arbitrary provider token to these endpoints; a provider-specific verifier/exchange is not implemented here.

### API contract

All paths below are relative to `/api/v1`. Send `Authorization: Bearer <mobile assertion>` and `Content-Type: application/json`.

**GET `/mobile/barangays?page=1&pageSize=50`** lists active service barangay IDs, names, cities and provinces. Load later pages according to `pagination.totalPages`. Use these IDs when connecting existing mobile accounts; do not guess IDs or rely on matching barangay names alone. This endpoint contains no people or staff directory.

**GET `/mobile/me`** returns `{ success: true, data: { account, beneficiary } }`. Before submission both are null. `account.status` is `PENDING`, `REJECTED`, or `LINKED`; it includes `revision` and the correction `reviewNote`. `beneficiary` contains only the linked active person's ID, name, birth date, barangay and status. An inactive record returns no active beneficiary. No mobile caller can search other people's records or possible matches.

**POST `/mobile/link-request`**, initial request:

```json
{
  "firstName": "Maria",
  "middleName": null,
  "lastName": "Santos",
  "birthDate": "1990-01-12",
  "barangayId": "11111111-1111-4111-8111-111111111111"
}
```

Use a real active barangay ID. To correct an existing unlinked request, include `revision` from the latest GET. Repeating the same pending submission reuses the request; edits require the current revision. A linked account cannot request a different person. The response contains the saved account; it never creates a beneficiary. Read status on app sign-in, return from background, and after user-initiated refresh; do not poll continuously.

**Staff APIs:** GET `/mobile-account-requests?status=PENDING&page=1&pageSize=20`; POST `/mobile-account-requests/:accountId/decision` with either `{ decision: "LINK", beneficiaryId, confirmedIdentity: true, revision, note }` or `{ decision: "REJECT", revision, note }`. Staff authentication and role/barangay scope are mandatory. Both return safe account details; external login subjects are not exposed.

## Imports, pictures, and identity

Existing imports continue to flag exact identity/email/PhilSys duplicates instead of merging or overwriting them. Matching depends on the quality of the submitted data; spelling changes and different biographical details require staff investigation. Account linking avoids a second beneficiary from mobile registration, but cannot determine by itself whether two differently named records represent the same human.

A mobile avatar is not a verified face profile. This change does not upload or expose profile photos and never turns an avatar into biometric evidence. Existing consent, face enrollment, duplicate review, and claim checks remain separate.

## Apply and verify

Run `npm run prisma:migrate:deploy` and `npm run prisma:generate`, then restart the existing API terminal. The additive migration creates only the mobile-account table, unique indexes, and link-state constraint; existing beneficiaries are untouched.

`node --test test/mobileAccount.test.js` uses synthetic identities and mocked persistence. For real PostgreSQL uniqueness/state checks, run `$env:RUN_MOBILE_LINK_DATABASE_TESTS='1'; node --test test/mobileAccount.database.test.js` in PowerShell. All database fixtures run in transactions that always roll back. No real beneficiary is linked by these checks.
