# Distribution Allocation Management Phase 3

## Scope

System Administrators create, cancel, and reactivate distribution allocations. DSWD Staff can monitor every allocation. Barangay Facilitators can read only the allocations and eligible enrollments for events in their assigned Barangay.

An allocation is the required link between an approved enrollment and a distribution event. Phase 3 does not create schedules, queue numbers, QR tokens, claims, transactions, payouts, or notifications.

## Endpoints

| Method | Endpoint | Access |
|---|---|---|
| `GET` | `/api/v1/distributions/:distributionId/eligible-enrollments` | All staff, Barangay-scoped |
| `POST` | `/api/v1/distributions/:distributionId/allocations` | System Administrator |
| `GET` | `/api/v1/distributions/:distributionId/allocations` | All staff, Barangay-scoped |
| `GET` | `/api/v1/distributions/:distributionId/allocations/:allocationId` | All staff, Barangay-scoped |
| `POST` | `/api/v1/distributions/:distributionId/allocations/:allocationId/cancel` | System Administrator |
| `POST` | `/api/v1/distributions/:distributionId/allocations/:allocationId/reactivate` | System Administrator |

## Enforced rules

- The event must be `DRAFT` for create, cancel, and reactivate operations.
- Every enrollment must be `APPROVED`, use the event's program, and belong to an active beneficiary in the event's Barangay.
- The API derives `amount` from `Program.grantAmount`; clients cannot submit an amount.
- `grantAmount` must be positive. A configured `budgetAmount` cannot be exceeded across non-cancelled program allocations.
- One request accepts 1 to 100 unique enrollment UUIDs and succeeds or fails as one serializable transaction.
- One beneficiary/enrollment can have only one allocation in each event.
- Creation requires an `Idempotency-Key` UUID. Repeating the same key and body returns the original response. Reusing the key with another body returns `409 IDEMPOTENCY_KEY_REUSED`.
- Lifecycle: `ALLOCATED -> CANCELLED -> ALLOCATED`. A `CLAIMED` allocation is immutable.
- Once allocations exist, the event's program and Barangay are locked. Title and location remain editable while the event is draft.
- Cancelling an event automatically cancels all of its unclaimed allocations.
- Allocation responses omit address, contact details, PhilSys number, credentials, and downstream claim data.

## Step-by-step Postman test

### 1. Restart the API and log in again

```powershell
npm.cmd run dev
```

The current local development setting keeps access tokens valid for 24 hours to make Postman testing easier. Production configuration still restricts access tokens to 5 minutes through 1 hour. Log in through:

```http
POST {{baseUrl}}/auth/login
Content-Type: application/json
```

Use each account's existing identifier, password, and current TOTP code when enabled. In **Scripts -> After response**, save the Admin token:

```javascript
const response = pm.response.json();
pm.environment.set("adminToken", response.data.accessToken);
```

Repeat using `dswdToken` and `barangayToken` as the environment-variable names.

### 2. Check the Postman environment

Add or confirm these variables:

```text
baseUrl
adminToken
dswdToken
barangayToken
programId
barangayId
distributionId
eligibleEnrollmentId
allocationId
allocationRequestKey
```

The program must be `ACTIVE`, have a positive `grantAmount`, and have enough `budgetAmount`. The distribution must be `DRAFT`. Its `programId` and `barangayId` must match the enrollment and beneficiary.

### 3. Create or reuse a fresh draft distribution

You may reuse your Phase 2 draft event, even when it already has slots. Otherwise:

```http
POST {{baseUrl}}/distributions
Authorization: Bearer {{adminToken}}
Content-Type: application/json
```

```json
{
  "programId": "{{programId}}",
  "title": "Phase 3 Allocation Test",
  "distributionDate": "2026-10-20",
  "startTime": "08:00",
  "endTime": "10:00",
  "slotDurationMinutes": 30,
  "location": "Barangay Hall",
  "barangayId": "{{barangayId}}"
}
```

Use an unused future date. Expected: `201 Created`, status `DRAFT`.

Save the event in **Scripts -> After response**:

```javascript
const response = pm.response.json();
pm.environment.set("distributionId", response.data.distribution.distributionId);
```

### 4. Find an eligible approved enrollment

```http
GET {{baseUrl}}/distributions/{{distributionId}}/eligible-enrollments?page=1&pageSize=20
Authorization: Bearer {{adminToken}}
```

Expected: `200 OK`. Only approved enrollments for the same program, active beneficiary, and same Barangay are returned. Already allocated enrollments are excluded.

Save the first result in **Scripts -> After response**:

```javascript
const response = pm.response.json();
pm.environment.set(
  "eligibleEnrollmentId",
  response.data.enrollments[0].enrollmentId
);
```

If `enrollments` is empty, do not continue yet. Approve a matching enrollment or create the event with the enrollment's program and Barangay.

### 5. Generate one stable Idempotency-Key

On the allocation-create request, open **Scripts -> Before request** and add:

```javascript
if (!pm.environment.get("allocationRequestKey")) {
  pm.environment.set(
    "allocationRequestKey",
    pm.variables.replaceIn("{{$guid}}")
  );
}
```

This creates the UUID once and keeps it stable for the replay test. When you want a genuinely new allocation request, delete `allocationRequestKey` from the environment and send again.

### 6. Create the allocation as System Administrator

```http
POST {{baseUrl}}/distributions/{{distributionId}}/allocations
Authorization: Bearer {{adminToken}}
Idempotency-Key: {{allocationRequestKey}}
Content-Type: application/json
```

```json
{
  "enrollmentIds": ["{{eligibleEnrollmentId}}"]
}
```

Do not include `amount`; the server reads it from the program.

Expected: `201 Created`, `allocationStatus` is `ALLOCATED`, and the response header `Idempotency-Replayed` is `false`.

Save the allocation in **Scripts -> After response**:

```javascript
const response = pm.response.json();
pm.environment.set(
  "allocationId",
  response.data.allocations[0].allocationId
);
```

### 7. Confirm idempotent replay

Press **Send** again without changing the header or body.

Expected: `201 Created`, the same `allocationId`, response header `Idempotency-Replayed: true`, and only one database allocation.

Then change the body to another enrollment while keeping the same key. Expected: `409 IDEMPOTENCY_KEY_REUSED`. Restore the original body afterward.

### 8. Confirm wrong-role protection

Repeat the create request with `{{dswdToken}}`, then `{{barangayToken}}`.

Expected for both: `403 FORBIDDEN`. Only a System Administrator can mutate allocations.

### 9. List, filter, search, and paginate

```http
GET {{baseUrl}}/distributions/{{distributionId}}/allocations?status=ALLOCATED&page=1&pageSize=20
Authorization: Bearer {{dswdToken}}
```

Expected: `200 OK`, a `summary`, and pagination. Search accepts a beneficiary name or an exact allocation, enrollment, or beneficiary UUID:

```http
GET {{baseUrl}}/distributions/{{distributionId}}/allocations?search={{eligibleEnrollmentId}}&page=1&pageSize=20
Authorization: Bearer {{adminToken}}
```

Use `{{barangayToken}}`; expected `200 OK` only when the event is in that facilitator's assigned Barangay. A different Barangay event is returned as `404` to prevent record discovery.

### 10. Read one allocation

```http
GET {{baseUrl}}/distributions/{{distributionId}}/allocations/{{allocationId}}
Authorization: Bearer {{dswdToken}}
```

Expected: `200 OK`. Confirm that the response does not contain beneficiary address, contact number, email, PhilSys number, passwords, TOTP secrets, or claim data.

### 11. Cancel the allocation

```http
POST {{baseUrl}}/distributions/{{distributionId}}/allocations/{{allocationId}}/cancel
Authorization: Bearer {{adminToken}}
```

Expected: `200 OK`, status `CANCELLED`. Sending it again returns `409 INVALID_DISTRIBUTION_ALLOCATION_TRANSITION`.

### 12. Reactivate the allocation

```http
POST {{baseUrl}}/distributions/{{distributionId}}/allocations/{{allocationId}}/reactivate
Authorization: Bearer {{adminToken}}
```

Expected: `200 OK`, status `ALLOCATED`. Reactivation rechecks the program budget.

### 13. Confirm event scope locking

After the first allocation, this Admin request must fail:

```http
PATCH {{baseUrl}}/distributions/{{distributionId}}
Authorization: Bearer {{adminToken}}
Content-Type: application/json
```

```json
{
  "barangayId": "another-valid-barangay-uuid"
}
```

Expected: `409 DISTRIBUTION_ALLOCATION_SCOPE_LOCKED`. Changing `programId` is also locked. Updating only `title` or `location` remains allowed while the event is `DRAFT`.

### 14. Check the audit logs

```http
GET {{baseUrl}}/audit-logs?entityAffected=DISTRIBUTION_ALLOCATION&recordId={{allocationId}}&page=1&pageSize=20
Authorization: Bearer {{dswdToken}}
```

Expected actions after the full lifecycle:

```text
DISTRIBUTION_ALLOCATION_CREATED
DISTRIBUTION_ALLOCATION_CANCELLED
DISTRIBUTION_ALLOCATION_REACTIVATED
```

### 15. Optional event cancellation test - do this last

```http
POST {{baseUrl}}/distributions/{{distributionId}}/cancel
Authorization: Bearer {{adminToken}}
```

Expected: event status `CANCELLED`, every unclaimed allocation becomes `CANCELLED`, and later allocation mutations return `409 DISTRIBUTION_ALLOCATIONS_NOT_EDITABLE`.

## Automated verification

```powershell
npm.cmd run verify:distribution:allocations
npm.cmd run verify:distribution
npm.cmd run security:check
```

The verification scripts create temporary records and remove them in a `finally` cleanup. They do not modify your saved beneficiary, program, enrollment, distribution, slot, or allocation records.
