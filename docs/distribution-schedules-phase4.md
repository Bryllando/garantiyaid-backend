# Distribution Scheduling and Queue Management Phase 4

## Scope

Phase 4 turns each active distribution allocation into one timed schedule with a queue number. System Administrators manage schedules and open ready events. DSWD Staff can monitor every event. Barangay Facilitators can read schedules only for events in their assigned Barangay.

Phase 4 does not create QR tokens, perform scans or claims, send notifications, create payouts or wallet transactions, capture biometrics, or add frontend behavior.

## Workflow

```text
Approved Enrollment
  -> ALLOCATED Distribution Allocation
  -> SCHEDULED Distribution Schedule
  -> Slot and Queue Number
  -> Distribution DRAFT -> OPEN
  -> Phase 5 QR and Claim Verification
```

## Endpoints

All paths below are relative to `/api/v1` and require a staff Bearer token.

| Method | Endpoint | Access |
|---|---|---|
| `GET` | `/distributions/:distributionId/schedulable-allocations` | All staff; Barangay-scoped |
| `POST` | `/distributions/:distributionId/schedules/generate` | System Administrator |
| `POST` | `/distributions/:distributionId/schedules` | System Administrator |
| `GET` | `/distributions/:distributionId/schedules` | All staff; Barangay-scoped |
| `GET` | `/distributions/:distributionId/schedules/:scheduleId` | All staff; Barangay-scoped |
| `POST` | `/distributions/:distributionId/schedules/:scheduleId/reschedule` | System Administrator |
| `POST` | `/distributions/:distributionId/schedules/:scheduleId/cancel` | System Administrator |
| `POST` | `/distributions/:distributionId/schedules/:scheduleId/reactivate` | System Administrator |
| `POST` | `/distributions/:distributionId/open` | System Administrator |

## Enforced rules

- Schedule mutations are allowed only while the distribution is `DRAFT`.
- Only an allocation with `allocationStatus: ALLOCATED` can receive or reactivate a schedule.
- The selected slot must belong to the same distribution and have `slotStatus: AVAILABLE`.
- Active schedule occupancy cannot exceed slot capacity.
- `SCHEDULED`, `CHECKED_IN`, and `MISSED` schedules occupy capacity; `CANCELLED` schedules do not.
- One beneficiary can have only one schedule per distribution.
- Queue numbers are unique within a slot. New assignments use one number after the highest queue number currently stored in that slot; cancelled schedules retain their number.
- A slot automatically becomes `FULL` when its last place is assigned and returns to `AVAILABLE` when cancellation or rescheduling releases a place.
- A slot with active schedules cannot be manually closed. Capacity cannot be reduced below active occupancy.
- Automatic generation orders beneficiaries by last name and first name, then fills available slots chronologically.
- Automatic generation is all-or-nothing. If available capacity cannot hold every requested allocation, no schedule is created.
- Automatic generation accepts an optional `allocationIds` array containing 1 to 500 unique UUIDs. Omitting it schedules every currently schedulable allocation.
- Automatic generation requires an `Idempotency-Key` UUID. Replaying the same key and body returns the original result; changing the body returns `409 IDEMPOTENCY_KEY_REUSED`.
- Only a `SCHEDULED` schedule can be rescheduled or cancelled. Only a `CANCELLED` schedule can be reactivated.
- Reactivation rechecks the allocation, slot status, and capacity.
- Cancelling an allocated allocation also cancels its active schedule and releases slot capacity.
- Cancelling a draft event cancels its schedules and allocations and closes its slots.
- Opening requires at least one active allocation and an active schedule for every active allocation.
- Opening rechecks schedule/allocation ownership and slot capacity in one serializable transaction.
- `DRAFT -> OPEN` freezes event fields, slots, allocations, and schedules because every mutation endpoint requires `DRAFT`.
- Every Phase 4 mutation creates an audit log.
- Responses expose only operational beneficiary identity: UUID, name, Barangay, and lifecycle status. They omit address, contact details, email, PhilSys number, credentials, documents, biometric data, QR data, claims, and wallet data.

## Migration assessment

No Phase 4 migration is required. The existing `Schedule` model already contains:

- `distributionId`, `beneficiaryId`, and `slotId` relations;
- `queueNumber`, `status`, and `assignedByAi`;
- `@@unique([distributionId, beneficiaryId])`;
- `@@unique([slotId, queueNumber])`.

The existing `IdempotencyRecord` table is reused for schedule batch generation. Existing records and migrations are preserved; no database reset or recreation is needed.

## Postman setup

### 1. Start the API

From `garantiyaid-backend`:

```powershell
npm.cmd run dev
```

Keep `JWT_ACCESS_EXPIRES_IN=24h` in the local test environment as already configured. Do not use this long expiry for production.

### 2. Create a Postman environment

Add these variables:

```text
baseUrl                 http://localhost:4000/api/v1
adminToken
dswdToken
barangayToken
distributionId
allocationId
secondAllocationId
slotId
secondSlotId
scheduleId
scheduleGenerationKey
```

### 3. Log in with each role

```http
POST {{baseUrl}}/auth/login
Content-Type: application/json
```

Use the account's current login identifier, password, and TOTP code when required. Save the returned access token in **Scripts -> After response**:

```javascript
const response = pm.response.json();
pm.environment.set("adminToken", response.data.accessToken);
```

Repeat for DSWD Staff using `dswdToken`, and for the Barangay Facilitator using `barangayToken`.

## Step-by-step Phase 4 test

### 1. Prepare a draft event

Use a distribution that meets all of these conditions:

- status is `DRAFT`;
- it has generated `AVAILABLE` slots;
- it has at least two `ALLOCATED` allocations;
- the allocations belong to active beneficiaries in the same program and Barangay.

Save the distribution, allocation, and slot UUIDs in the Postman environment. The Phase 1–3 documentation explains how to create them if needed.

### 2. List schedulable allocations

```http
GET {{baseUrl}}/distributions/{{distributionId}}/schedulable-allocations?page=1&pageSize=20
Authorization: Bearer {{adminToken}}
```

Expected: `200 OK`. Only `ALLOCATED` beneficiaries without any schedule in this event appear.

You can search by beneficiary name or exact allocation, enrollment, or beneficiary UUID:

```http
GET {{baseUrl}}/distributions/{{distributionId}}/schedulable-allocations?search={{allocationId}}
Authorization: Bearer {{adminToken}}
```

### 3. Assign one beneficiary manually

```http
POST {{baseUrl}}/distributions/{{distributionId}}/schedules
Authorization: Bearer {{adminToken}}
Content-Type: application/json
```

```json
{
  "allocationId": "{{allocationId}}",
  "slotId": "{{slotId}}"
}
```

Expected: `201 Created`, `status: SCHEDULED`, `assignedByAi: false`, and a positive `queueNumber`.

Save the schedule UUID in **Scripts -> After response**:

```javascript
const response = pm.response.json();
pm.environment.set("scheduleId", response.data.schedule.scheduleId);
```

Send the same request again. Expected: `409 BENEFICIARY_ALREADY_SCHEDULED`.

### 4. Confirm wrong-role protection

Repeat the manual request with `{{dswdToken}}`, then `{{barangayToken}}`.

Expected: `403 FORBIDDEN` for both. Read access does not grant mutation access.

### 5. Generate schedules automatically

On the generation request, add this in **Scripts -> Before request**:

```javascript
if (!pm.environment.get("scheduleGenerationKey")) {
  pm.environment.set(
    "scheduleGenerationKey",
    pm.variables.replaceIn("{{$guid}}")
  );
}
```

To generate schedules for selected allocations:

```http
POST {{baseUrl}}/distributions/{{distributionId}}/schedules/generate
Authorization: Bearer {{adminToken}}
Idempotency-Key: {{scheduleGenerationKey}}
Content-Type: application/json
```

```json
{
  "allocationIds": ["{{secondAllocationId}}"]
}
```

Expected: `201 Created`, `assignedByAi: true`, and response header `Idempotency-Replayed: false`.

To schedule every remaining schedulable allocation instead, send an empty object with a new key:

```json
{}
```

The generation is all-or-nothing. If the available slots are too small, expected: `409 INSUFFICIENT_DISTRIBUTION_SLOT_CAPACITY` with requested, available, and shortfall counts.

### 6. Confirm idempotent replay

Send the exact same generation request again without changing the key or body.

Expected: `201 Created`, the same schedule UUIDs, and `Idempotency-Replayed: true`.

Change `allocationIds` while keeping the same key. Expected: `409 IDEMPOTENCY_KEY_REUSED`. Restore the original body afterward. Delete `scheduleGenerationKey` before starting a genuinely new batch.

### 7. List, filter, search, and paginate schedules

```http
GET {{baseUrl}}/distributions/{{distributionId}}/schedules?status=SCHEDULED&page=1&pageSize=20
Authorization: Bearer {{dswdToken}}
```

Expected: `200 OK` with `schedules`, `summary.countsByStatus`, and `pagination`.

Supported optional filters:

```text
status=SCHEDULED|CHECKED_IN|MISSED|CANCELLED
slotId=<slot UUID>
search=<name, exact schedule/beneficiary/slot UUID, or queue number>
page=<positive integer>
pageSize=<1 through 100>
```

Use `{{barangayToken}}`. Expected: `200 OK` only when the event is in the facilitator's assigned Barangay. Another Barangay's event returns `404 DISTRIBUTION_NOT_FOUND` to avoid disclosing that record.

### 8. Read one schedule

```http
GET {{baseUrl}}/distributions/{{distributionId}}/schedules/{{scheduleId}}
Authorization: Bearer {{dswdToken}}
```

Expected: `200 OK`. Confirm that no address, contact number, email, PhilSys number, credentials, documents, biometric data, QR tokens, claims, or wallet information appears.

### 9. Reschedule

Choose a different `AVAILABLE` slot with capacity:

```http
POST {{baseUrl}}/distributions/{{distributionId}}/schedules/{{scheduleId}}/reschedule
Authorization: Bearer {{adminToken}}
Content-Type: application/json
```

```json
{
  "slotId": "{{secondSlotId}}"
}
```

Expected: `200 OK`, the new slot UUID, and that slot's next never-before-used queue number. Using the current slot returns `409 DISTRIBUTION_SCHEDULE_SLOT_UNCHANGED`.

### 10. Cancel the schedule

```http
POST {{baseUrl}}/distributions/{{distributionId}}/schedules/{{scheduleId}}/cancel
Authorization: Bearer {{adminToken}}
```

Expected: `200 OK`, `status: CANCELLED`, and one place released in the slot. Sending it again returns `409 INVALID_DISTRIBUTION_SCHEDULE_TRANSITION`.

### 11. Confirm opening readiness blocks a cancelled schedule

```http
POST {{baseUrl}}/distributions/{{distributionId}}/open
Authorization: Bearer {{adminToken}}
```

Expected: `409 DISTRIBUTION_ALLOCATIONS_UNSCHEDULED` because the allocation has no active schedule.

### 12. Reactivate the schedule

```http
POST {{baseUrl}}/distributions/{{distributionId}}/schedules/{{scheduleId}}/reactivate
Authorization: Bearer {{adminToken}}
```

Expected: `200 OK`, `status: SCHEDULED`. Reactivation fails if its allocation is no longer `ALLOCATED`, the slot is closed/full, or the event is no longer `DRAFT`.

### 13. Open the ready event

First confirm every `ALLOCATED` allocation now has an active schedule. Then:

```http
POST {{baseUrl}}/distributions/{{distributionId}}/open
Authorization: Bearer {{adminToken}}
```

Expected: `200 OK`, event `status: OPEN`.

Repeat with `{{dswdToken}}` on a separate draft event. Expected: `403 FORBIDDEN`.

### 14. Confirm the event is frozen

Repeat any manual assignment, generation, reschedule, cancel, or reactivate request after opening.

Expected: `409 DISTRIBUTION_SCHEDULES_NOT_EDITABLE`. Slot and allocation mutation endpoints are also frozen because they require `DRAFT`.

### 15. Check audit logs

```http
GET {{baseUrl}}/audit-logs?entityAffected=SCHEDULE&recordId={{scheduleId}}&page=1&pageSize=20
Authorization: Bearer {{dswdToken}}
```

Depending on the performed actions, expected audit names include:

```text
DISTRIBUTION_SCHEDULE_CREATED
DISTRIBUTION_SCHEDULE_GENERATED
DISTRIBUTION_SCHEDULE_RESCHEDULED
DISTRIBUTION_SCHEDULE_CANCELLED
DISTRIBUTION_SCHEDULE_REACTIVATED
DISTRIBUTION_SCHEDULE_CANCELLED_WITH_ALLOCATION
DISTRIBUTION_SCHEDULES_CANCELLED_ON_EVENT_CANCELLATION
DISTRIBUTION_OPENED
```

## Automated verification

Run the Phase 4 unit tests and database-backed workflow verification:

```powershell
npm.cmd test
npm.cmd run prisma:validate
npm.cmd run verify:distribution:schedules
```

Run all distribution phases:

```powershell
npm.cmd run verify:distribution
```

The Phase 4 verification script creates isolated temporary beneficiaries, enrollments, a program, an event, slots, allocations, schedules, sessions, idempotency records, and audit logs. Its `finally` cleanup deletes only those tracked temporary records. It never resets, recreates, or migrates the database.
