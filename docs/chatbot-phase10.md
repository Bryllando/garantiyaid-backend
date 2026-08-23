# Phase 10 Controlled Chatbot API

## Approved security boundary

Phase 10 is a controlled prototype, not an unrestricted generative-AI service.
It uses deterministic local intent rules and a static, reviewed knowledge base.
It makes no external AI, HTTP, SQL, code-execution, or tool calls from user
messages.

Beneficiary mobile authentication does not exist yet. Therefore:

- Public sessions are generic and cannot be linked by supplying a
  `beneficiaryId`.
- A random 256-bit session token authorizes access only to that generic chat
  history. It never authorizes beneficiary records.
- Schedule, claim-status, and enrollment-status questions return a controlled
  privacy response and are escalated. They never query personal records.
- Only authenticated staff can read escalation queues, reply, or resolve.
- Facilitators can access only securely beneficiary-linked sessions in their
  assigned Barangay. They cannot access generic sessions.
- The API contains no staff impersonation, message editing, bulk deletion,
  claim, enrollment approval, QR scan, wallet, or payment action.

A separately approved beneficiary-authentication phase is required before the
chatbot can return any personal schedule, enrollment, claim, QR, or wallet data.

## Controlled intent vocabulary

- `DOCUMENT_REQUIREMENTS`
- `PROGRAM_INFORMATION`
- `DISTRIBUTION_SCHEDULE`
- `CLAIM_STATUS`
- `ENROLLMENT_STATUS`
- `CLAIM_PROCESS`
- `HUMAN_ASSISTANCE`
- `GREETING`
- `UNKNOWN`

Confidence is deterministic and bounded from 0 to 1. Unknown, ambiguous,
human-assistance, and personal-record intents escalate. Supported response
languages are English (`en`), Filipino (`fil`), and Cebuano (`ceb`).

## API contract

Public generic-session endpoints:

| Method | Path | Authentication |
| --- | --- | --- |
| POST | `/api/v1/chatbot/sessions` | Strict IP rate limit |
| GET | `/api/v1/chatbot/sessions/:sessionId` | `X-Chatbot-Session-Token` |
| GET | `/api/v1/chatbot/sessions/:sessionId/messages` | Session token |
| POST | `/api/v1/chatbot/sessions/:sessionId/messages` | Session token |
| POST | `/api/v1/chatbot/sessions/:sessionId/escalate` | Session token |
| POST | `/api/v1/chatbot/sessions/:sessionId/end` | Session token |

Staff endpoints:

| Method | Path | Authentication |
| --- | --- | --- |
| GET | `/api/v1/chatbot/escalations` | Staff bearer JWT |
| GET | `/api/v1/chatbot/escalations/:sessionId` | Staff bearer JWT and scope |
| POST | `/api/v1/chatbot/escalations/:sessionId/reply` | Staff bearer JWT and ownership |
| POST | `/api/v1/chatbot/escalations/:sessionId/resolve` | Staff bearer JWT and ownership |

All JSON bodies and queries reject unknown fields. Messages are plain text,
1-1000 characters, and HTML markup is rejected. Common credentials, tokens,
full Philippine mobile numbers, and PhilSys-like identifiers are redacted
before storage.

## Lifecycle and limits

Lifecycle:

`ACTIVE -> ESCALATED -> RESOLVED`

`ACTIVE|ESCALATED -> ENDED`

`RESOLVED` and `ENDED` are terminal. Reopening is not implemented. New
messages after a terminal state return HTTP 409. Duplicate escalation and
concurrent staff-ownership transitions also return HTTP 409.

Defaults are configurable in `.env`:

- 30 chatbot requests per IP per 15 minutes
- 100 total messages per session
- 24-hour active session duration
- 90-day retention marker

Terminal sessions become eligible for deletion only after `retentionUntil`.
No destructive public or bulk-deletion endpoint exists. Production deletion
must be an approved operations job that deletes only terminal, expired chatbot
sessions; message rows cascade only with that exact session deletion.

Messages have a unique per-session sequence. Reads order by sequence and then
message ID. Queue reads order by last activity and then session ID.

## Audit and realtime behavior

Audit actions:

- `CHATBOT_SESSION_ESCALATED`
- `CHATBOT_STAFF_REPLIED`
- `CHATBOT_SESSION_RESOLVED`
- `CHATBOT_SESSION_ENDED`

Automatic/user lifecycle actions use `actorType=SYSTEM` and no fabricated
staff user. Staff actions retain the authenticated `userId`. Audit metadata
contains reason/status codes and sequence metadata, never conversation text.

Server-only Socket.IO events:

- `chatbot.session.escalated`
- `chatbot.staff_reply.created`
- `chatbot.session.resolved`
- `chatbot.metrics.updated`

Admin and DSWD rooms receive global events. A facilitator room receives an
event only when the session has a securely linked beneficiary in that assigned
Barangay. Event payloads contain lifecycle metadata, not message text or the
anonymous session token. Client attempts to publish trusted events receive
`CLIENT_EVENT_PUBLICATION_FORBIDDEN`.

## Beginner-friendly Postman test

### 1. Start the backend

From `garantiyaid-backend` run:

```powershell
npm run dev
```

Create a Postman environment with:

- `baseUrl` = `http://localhost:4000/api/v1`
- `sessionId` = blank
- `chatbotSessionToken` = blank
- `accessToken` = your existing staff token, or blank until staff login

Every POST request below uses `Body -> raw -> JSON` and the header
`Content-Type: application/json`.

### 2. Create a generic session

`POST {{baseUrl}}/chatbot/sessions`

```json
{
  "language": "en"
}
```

Expected: HTTP 201, `status=ACTIVE`, `isGeneric=true`, and
`beneficiaryAuthenticationAvailable=false`.

In the request's **Tests** tab save the one-time credentials:

```javascript
const body = pm.response.json();
pm.environment.set("sessionId", body.data.session.sessionId);
pm.environment.set("chatbotSessionToken", body.data.sessionToken);
```

Do not put this token in the staff `Authorization` header.

### 3. Ask a controlled generic question

`POST {{baseUrl}}/chatbot/sessions/{{sessionId}}/messages`

Add header:

`X-Chatbot-Session-Token: {{chatbotSessionToken}}`

```json
{
  "messageText": "What documents do I need?"
}
```

Expected: HTTP 201, intent `DOCUMENT_REQUIREMENTS`, confidence from 0 to 1,
`deterministic=true`, `externalAiUsed=false`, and no escalation.

Repeat with `Hello` and expect `GREETING`. Create another session with
`"language": "ceb"` and repeat to see the controlled Cebuano response.

### 4. Verify privacy escalation

Use the same message endpoint:

```json
{
  "messageText": "What is the status of my claim?"
}
```

Expected: HTTP 201, intent `CLAIM_STATUS`, session status `ESCALATED`, reason
`PERSONAL_DATA_REQUIRED`, and a response explaining that ownership must be
verified by staff. No claim result is returned.

### 5. Read ordered history

`GET {{baseUrl}}/chatbot/sessions/{{sessionId}}/messages?page=1&pageSize=20`

Add the session-token header. Expected: HTTP 200 and sequences `1, 2, 3, 4`
for two user/bot turns.

Also request:

`GET {{baseUrl}}/chatbot/sessions/{{sessionId}}`

The session is returned, but the stored token hash is never returned.

### 6. Run negative privacy and validation tests

Create-session request with an untrusted beneficiary ID:

```json
{
  "language": "en",
  "beneficiaryId": "11111111-1111-4111-8111-111111111111"
}
```

Expected: HTTP 400 `VALIDATION_ERROR`.

Other checks:

- Remove `X-Chatbot-Session-Token`: HTTP 401.
- Use 43 incorrect token characters: HTTP 404.
- Use a malformed session UUID: HTTP 400.
- Send a 1001-character message: HTTP 400.
- Send `<script>alert(1)</script>`: HTTP 400.
- Add an unknown JSON property: HTTP 400.
- Send a phone number or credential in plain text: HTTP 201 with
  `inputRedacted=true`; history contains a redaction marker, not the value.

### 7. Verify duplicate escalation protection

After the claim-status message, call:

`POST {{baseUrl}}/chatbot/sessions/{{sessionId}}/escalate`

with the session-token header:

```json
{
  "reason": "HUMAN_REQUESTED"
}
```

Expected: HTTP 409 `CHATBOT_ALREADY_ESCALATED` and no second escalation audit
transition.

### 8. Obtain a staff access token

Use the existing Phase 1 authentication flow:

`POST {{baseUrl}}/auth/login`

```json
{
  "identifier": "your-staff-id-or-username",
  "password": "your-password",
  "totpCode": "your-current-6-digit-code"
}
```

Save `data.accessToken` as `accessToken`. If the response says TOTP enrollment
or confirmation is required, complete the existing `/auth/totp/setup` and
`/auth/totp/confirm` flow first.

For every staff request add:

`Authorization: Bearer {{accessToken}}`

Do not add the anonymous chatbot-session token to staff routes.

### 9. View the escalation queue and detail

`GET {{baseUrl}}/chatbot/escalations?page=1&pageSize=20&status=ESCALATED`

Expected for System Admin or DSWD Staff: HTTP 200 and the generic escalated
session. Queue rows contain lifecycle metadata, not full conversations.

`GET {{baseUrl}}/chatbot/escalations/{{sessionId}}`

Expected: HTTP 200 with the authorized conversation detail.

A Barangay Facilitator using the same generic `sessionId` must receive HTTP 403
`CHATBOT_GENERIC_SESSION_FORBIDDEN`. Future beneficiary-linked sessions are
visible only when their beneficiary belongs to the facilitator's assigned
Barangay; the automated suite covers same- and cross-Barangay enforcement.

### 10. Reply as staff

`POST {{baseUrl}}/chatbot/escalations/{{sessionId}}/reply`

```json
{
  "messageText": "Please coordinate with the authorized DSWD desk for identity verification."
}
```

Expected: HTTP 201, sender type `STAFF`, a new sequence, and the authenticated
staff member becomes the escalation owner. A different staff user attempting a
reply must receive HTTP 409 `CHATBOT_SESSION_ASSIGNED`.

Read public history again with the anonymous session token. The staff reply is
visible as sender type `STAFF`; staff credentials are not exposed.

### 11. Resolve explicitly

`POST {{baseUrl}}/chatbot/escalations/{{sessionId}}/resolve`

```json
{
  "resolutionCode": "REFERRED_TO_DSWD"
}
```

Allowed codes are `ANSWERED`, `REFERRED_TO_BARANGAY`, `REFERRED_TO_DSWD`,
`DUPLICATE_INQUIRY`, and `OUT_OF_SCOPE`.

Expected: HTTP 200, status `RESOLVED`, an `endedAt` timestamp, and the selected
resolution code. Repeating resolve or sending another user message returns
HTTP 409.

### 12. Test manual end on a fresh session

Create a second session, then call:

`POST {{baseUrl}}/chatbot/sessions/{{sessionId}}/end`

with the session-token header and body `{}`.

Expected: HTTP 200 and status `ENDED`. Any later message returns HTTP 409.

### 13. Test the dedicated rate limit

In Postman Runner, repeat a harmless session GET more than 30 times within 15
minutes from the same client address. At least one response must be HTTP 429
`RATE_LIMIT_EXCEEDED`. Wait for the window to expire before continuing manual
tests.

### 14. Test Socket.IO isolation and spoofing

Create a Postman Socket.IO request to `http://localhost:4000` with auth payload:

```json
{
  "accessToken": "{{accessToken}}"
}
```

Listen for the four `chatbot.*` events. Trigger escalation, reply, and resolve
through REST. Events must contain lifecycle metadata but no `messageText`,
contact number, or session token. A facilitator must not receive a generic or
different-Barangay event.

Try emitting `chatbot.session.resolved` from the client. The server must answer
with `realtime.error` and code `CLIENT_EVENT_PUBLICATION_FORBIDDEN`; no trusted
event is broadcast.

## Automated verification

Run:

```powershell
npm run verify:chatbot
npm test
npm run prisma:validate
npm run security:static
npm audit --omit=dev --audit-level=high
```

The Phase 10 tests cover strict schemas, deterministic classification,
confidence bounds, controlled answers, redaction, token ownership, multi-turn
ordering, terminal states, rate-limit wiring, staff ownership, audit privacy,
RBAC/Barangay isolation, realtime vocabulary, spoof rejection inherited from
the shared Socket.IO layer, and absence of external AI/network/tool execution.
