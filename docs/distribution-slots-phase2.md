# Distribution Slots Phase 2

## Scope

System Administrators generate and manage time slots for draft distribution events. DSWD Staff can monitor all slots. Barangay Facilitators can read slots only for distribution events in their assigned Barangay.

This phase does not create allocations, beneficiary schedules, queue numbers, QR tokens, claims, payouts, or notifications.

## Endpoints

| Method | Endpoint | Access |
|---|---|---|
| `POST` | `/api/v1/distributions/:distributionId/slots/generate` | System Administrator |
| `GET` | `/api/v1/distributions/:distributionId/slots` | All staff, Barangay-scoped |
| `GET` | `/api/v1/distributions/:distributionId/slots/:slotId` | All staff, Barangay-scoped |
| `PATCH` | `/api/v1/distributions/:distributionId/slots/:slotId` | System Administrator |
| `POST` | `/api/v1/distributions/:distributionId/slots/:slotId/close` | System Administrator |
| `POST` | `/api/v1/distributions/:distributionId/slots/:slotId/reopen` | System Administrator |

Slot generation requires a draft event whose total duration divides evenly by `slotDurationMinutes`. Generated timestamps are returned with an explicit Philippine `+08:00` offset. Generating twice returns `409 DISTRIBUTION_SLOTS_ALREADY_EXIST`.

Once slots exist, `distributionDate`, `startTime`, `endTime`, and `slotDurationMinutes` cannot be changed. Other draft fields such as `title` and `location` remain editable. Cancelling the event closes all its slots.

## Step-by-step Postman test

### 1. Restart and log in again

```powershell
npm.cmd run dev
```

Get new Admin, DSWD, and Barangay tokens after restarting when necessary. The current local development setting keeps tokens valid for 24 hours for Postman convenience; production remains limited to 5 minutes through 1 hour. Use `POST {{baseUrl}}/auth/login`, then save `response.data.accessToken` in the matching environment variable.

### 2. Check the required Postman environment variables

```text
baseUrl
adminToken
dswdToken
barangayToken
programId
barangayId
distributionId
slotId
```

`programId` must identify an ACTIVE program. `barangayId` must identify an active Barangay and must match the Barangay Facilitator's assignment if that facilitator will test read access.

### 3. Create a fresh draft distribution event

```http
POST {{baseUrl}}/distributions
Authorization: Bearer {{adminToken}}
Content-Type: application/json
```

```json
{
  "programId": "{{programId}}",
  "title": "Education Assistance Schedule",
  "distributionDate": "2026-09-20",
  "startTime": "08:00",
  "endTime": "10:00",
  "slotDurationMinutes": 30,
  "location": "Barangay Hall",
  "barangayId": "{{barangayId}}"
}
```

Choose an unused future date. Expected response: `201 Created`, status `DRAFT`.

In Postman **Scripts → After response**, add:

```javascript
const response = pm.response.json();
pm.environment.set(
  "distributionId",
  response.data.distribution.distributionId
);
```

### 4. Generate the slots as System Administrator

```http
POST {{baseUrl}}/distributions/{{distributionId}}/slots/generate
Authorization: Bearer {{adminToken}}
Content-Type: application/json
```

```json
{
  "capacity": 30
}
```

Expected response: `201 Created`, 4 slots and total capacity 120:

```text
08:00–08:30
08:30–09:00
09:00–09:30
09:30–10:00
```

In **Scripts → After response**, save the first slot:

```javascript
const response = pm.response.json();
pm.environment.set("slotId", response.data.slots[0].slotId);
```

### 5. List and filter slots

```http
GET {{baseUrl}}/distributions/{{distributionId}}/slots?page=1&pageSize=20
Authorization: Bearer {{adminToken}}
```

Expected: `200 OK`, pagination total 4.

Filter available slots:

```http
GET {{baseUrl}}/distributions/{{distributionId}}/slots?slotStatus=AVAILABLE&page=1&pageSize=20
Authorization: Bearer {{dswdToken}}
```

Expected: `200 OK`. Replace the token with `{{barangayToken}}`; expected `200 OK` only when the event uses that facilitator's assigned Barangay.

### 6. Read one slot

```http
GET {{baseUrl}}/distributions/{{distributionId}}/slots/{{slotId}}
Authorization: Bearer {{dswdToken}}
```

Expected: `200 OK`. `slotStart` and `slotEnd` must end in `+08:00`.

### 7. Confirm wrong-role protection

Repeat the generation request using `{{dswdToken}}`, then `{{barangayToken}}`.

Expected for each: `403 FORBIDDEN`. Role authorization runs before the duplicate-generation check.

### 8. Update slot capacity as System Administrator

```http
PATCH {{baseUrl}}/distributions/{{distributionId}}/slots/{{slotId}}
Authorization: Bearer {{adminToken}}
Content-Type: application/json
```

```json
{
  "capacity": 40
}
```

Expected: `200 OK`, capacity 40. The same request with DSWD or Barangay token must return `403 FORBIDDEN`.

### 9. Close and reopen the slot

```http
POST {{baseUrl}}/distributions/{{distributionId}}/slots/{{slotId}}/close
Authorization: Bearer {{adminToken}}
```

Expected: `200 OK`, status `CLOSED`.

```http
POST {{baseUrl}}/distributions/{{distributionId}}/slots/{{slotId}}/reopen
Authorization: Bearer {{adminToken}}
```

Expected: `200 OK`, status `AVAILABLE`.

Closing an already closed slot or reopening an already available slot returns `409 INVALID_DISTRIBUTION_SLOT_TRANSITION`.

### 10. Confirm duplicate generation protection

Send the generation request again with the Admin token.

Expected: `409 DISTRIBUTION_SLOTS_ALREADY_EXIST`. The slot count must remain 4.

### 11. Confirm event schedule locking

```http
PATCH {{baseUrl}}/distributions/{{distributionId}}
Authorization: Bearer {{adminToken}}
Content-Type: application/json
```

```json
{
  "startTime": "09:00"
}
```

Expected: `409 DISTRIBUTION_SCHEDULE_LOCKED`.

A non-scheduling draft update remains allowed:

```json
{
  "title": "September Education Assistance"
}
```

Expected: `200 OK`.

### 12. Check audit logs

Batch-generation audit:

```http
GET {{baseUrl}}/audit-logs?action=DISTRIBUTION_SLOTS_GENERATED&entityAffected=DISTRIBUTION_SLOT&recordId={{distributionId}}
Authorization: Bearer {{adminToken}}
```

Individual slot audits:

```http
GET {{baseUrl}}/audit-logs?entityAffected=DISTRIBUTION_SLOT&recordId={{slotId}}
Authorization: Bearer {{dswdToken}}
```

Expected actions include:

```text
DISTRIBUTION_SLOT_CAPACITY_UPDATED
DISTRIBUTION_SLOT_CLOSED
DISTRIBUTION_SLOT_REOPENED
```

### 13. Optional cancellation test

Only do this last. It makes the test event unusable for future allocation work.

```http
POST {{baseUrl}}/distributions/{{distributionId}}/cancel
Authorization: Bearer {{adminToken}}
```

Expected: the event becomes `CANCELLED` and all four slots become `CLOSED`. Any later slot modification returns `409 DISTRIBUTION_SLOTS_NOT_EDITABLE`.

## Automated verification

```powershell
npm.cmd run verify:distribution
npm.cmd run security:check
```
