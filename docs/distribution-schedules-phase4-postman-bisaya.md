# Phase 4 Exact Postman Walkthrough (Bisaya)

Kini nga sequence gihimo aron usa ra ka fresh distribution ang gamiton gikan setup hangtod `OPEN`. Ayaw usba ang order sa tests kay naay mga test nga nagsalig sa previous result.

## Target test data

Gamit og fresh records nga adunay:

- 1 `DRAFT` distribution;
- 2 slots: `08:00-08:30` ug `08:30-09:00`;
- capacity nga `2` kada slot;
- 3 `ALLOCATED` beneficiaries;
- ang event, beneficiaries, ug facilitator naa sa parehas nga Barangay.

Final expected arrangement before opening:

```text
Slot 1: Allocation B + Allocation C
Slot 2: Allocation A
All three schedules: SCHEDULED
Distribution: DRAFT, then OPEN in the final step
```

## A. Postman environment

Paghimo og environment ug ibutang kini:

```text
baseUrl = http://localhost:4000/api/v1

adminIdentifier
adminPassword
adminToken

dswdIdentifier
dswdPassword
dswdToken

barangayIdentifier
barangayPassword
barangayToken

programId
barangayId
distributionId

eligibleEnrollmentId1
eligibleEnrollmentId2
eligibleEnrollmentId3
allocationRequestKey

allocationId1
allocationId2
allocationId3

slotId1
slotId2

scheduleId1
scheduleId2
scheduleId3
scheduleGenerationKey
```

## B. Start server

Sa terminal, sulod sa backend folder:

```powershell
cd C:\Users\Lenovo\Desktop\GARANTIYAID\garantiyaid-backend
npm.cmd run dev
```

Expected: modagan ang API sa port `4000`. Ayaw sirad-i ang terminal samtang nag-Postman test.

## C. Login ug save tokens

### Step 1 — Admin login

```http
POST {{baseUrl}}/auth/login
Content-Type: application/json
```

```json
{
  "identifier": "{{adminIdentifier}}",
  "password": "{{adminPassword}}",
  "totpCode": "CURRENT_6_DIGIT_CODE"
}
```

Kung ang first response kay `requiresTotp: true`, isend balik uban sa current six-digit TOTP code.

Sa **Scripts -> After response**:

```javascript
const json = pm.response.json();
if (json.data?.accessToken) {
  pm.environment.set("adminToken", json.data.accessToken);
}
```

Expected: `200 OK`, naay `data.accessToken`.

### Step 2 — DSWD login

Parehas nga endpoint ug body, pero gamita ang DSWD identifier/password/TOTP. Sa After response:

```javascript
const json = pm.response.json();
if (json.data?.accessToken) {
  pm.environment.set("dswdToken", json.data.accessToken);
}
```

### Step 3 — Barangay Facilitator login

Parehas gihapon, gamit ang facilitator credentials. Sa After response:

```javascript
const json = pm.response.json();
if (json.data?.accessToken) {
  pm.environment.set("barangayToken", json.data.accessToken);
}
```

## D. Prepare one clean distribution

Kung naa na kay fresh Phase 3 distribution nga `DRAFT`, adunay two available slots capacity 2, ug three active allocations, pwede ka mo-skip ngadto sa Section E.

### Step 4 — Create fresh DRAFT distribution

Gamita ang existing `ACTIVE` program ug matching Barangay. Ang date kinahanglan unused ug future date.

```http
POST {{baseUrl}}/distributions
Authorization: Bearer {{adminToken}}
Content-Type: application/json
```

```json
{
  "programId": "{{programId}}",
  "title": "Education Assistance Release - Batch A",
  "distributionDate": "2026-12-15",
  "startTime": "08:00",
  "endTime": "09:00",
  "slotDurationMinutes": 30,
  "location": "Barangay Hall",
  "barangayId": "{{barangayId}}"
}
```

Kung conflict ang date, ilisi og laing future date.

Sa After response:

```javascript
const json = pm.response.json();
pm.environment.set("distributionId", json.data.distribution.distributionId);
```

Expected: `201 Created`, `status: DRAFT`.

### Step 5 — Generate exactly two slots

```http
POST {{baseUrl}}/distributions/{{distributionId}}/slots/generate
Authorization: Bearer {{adminToken}}
Content-Type: application/json
```

```json
{
  "capacity": 2
}
```

Sa After response:

```javascript
const json = pm.response.json();
pm.environment.set("slotId1", json.data.slots[0].slotId);
pm.environment.set("slotId2", json.data.slots[1].slotId);
```

Expected: `201 Created`, two slots, total capacity `4`.

### Step 6 — Find three eligible enrollments

```http
GET {{baseUrl}}/distributions/{{distributionId}}/eligible-enrollments?page=1&pageSize=20
Authorization: Bearer {{adminToken}}
```

Expected: `200 OK` ug minimum three rows. Kung ubos sa three, hunong una: kinahanglan mo-approve/create og matching enrollments sa same active program ug same Barangay.

Sa After response:

```javascript
const rows = pm.response.json().data.enrollments;
if (rows.length >= 3) {
  pm.environment.set("eligibleEnrollmentId1", rows[0].enrollmentId);
  pm.environment.set("eligibleEnrollmentId2", rows[1].enrollmentId);
  pm.environment.set("eligibleEnrollmentId3", rows[2].enrollmentId);
}
```

### Step 7 — Generate allocation idempotency key

Sa **Scripts -> Before request** sa next allocation request:

```javascript
pm.environment.set("allocationRequestKey", pm.variables.replaceIn("{{$guid}}"));
```

Human sa first successful request, i-disable o tangtanga kini nga Before request script aron dili mausab ang key kung mag-replay test ka.

### Step 8 — Create three allocations

```http
POST {{baseUrl}}/distributions/{{distributionId}}/allocations
Authorization: Bearer {{adminToken}}
Idempotency-Key: {{allocationRequestKey}}
Content-Type: application/json
```

```json
{
  "enrollmentIds": [
    "{{eligibleEnrollmentId1}}",
    "{{eligibleEnrollmentId2}}",
    "{{eligibleEnrollmentId3}}"
  ]
}
```

Sa After response:

```javascript
const rows = pm.response.json().data.allocations;
pm.environment.set("allocationId1", rows[0].allocationId);
pm.environment.set("allocationId2", rows[1].allocationId);
pm.environment.set("allocationId3", rows[2].allocationId);
```

Expected: `201 Created`, three rows nga `allocationStatus: ALLOCATED`.

## E. Exact Phase 4 test order

### Step 9 — List schedulable allocations

```http
GET {{baseUrl}}/distributions/{{distributionId}}/schedulable-allocations?page=1&pageSize=20
Authorization: Bearer {{adminToken}}
```

Expected:

- `200 OK`;
- `schedulableAllocationCount: 3`;
- walay address, contact number, email, PhilSys number, password, QR, claim, o wallet data.

### Step 10 — Manual schedule Allocation A ngadto sa Slot 1

```http
POST {{baseUrl}}/distributions/{{distributionId}}/schedules
Authorization: Bearer {{adminToken}}
Content-Type: application/json
```

```json
{
  "allocationId": "{{allocationId1}}",
  "slotId": "{{slotId1}}"
}
```

Sa After response:

```javascript
const schedule = pm.response.json().data.schedule;
pm.environment.set("scheduleId1", schedule.scheduleId);
```

Expected:

- `201 Created`;
- `status: SCHEDULED`;
- `queueNumber: 1`;
- `assignedByAi: false`.

### Step 11 — Duplicate beneficiary protection

Isend balik ang exact Step 10 request.

Expected: `409 BENEFICIARY_ALREADY_SCHEDULED`. Dapat walay second schedule nga mahimo.

### Step 12 — Wrong-role mutation test

Isend ang Step 10 request gamit:

```http
Authorization: Bearer {{dswdToken}}
```

Expected: `403 FORBIDDEN`. Balika gamit `{{barangayToken}}`; expected gihapon `403 FORBIDDEN`.

### Step 13 — Create one stable schedule-generation key

Sa **Scripts -> Before request** sa generation request:

```javascript
if (!pm.environment.get("scheduleGenerationKey")) {
  pm.environment.set(
    "scheduleGenerationKey",
    pm.variables.replaceIn("{{$guid}}")
  );
}
```

### Step 14 — Auto-generate Allocation B only

```http
POST {{baseUrl}}/distributions/{{distributionId}}/schedules/generate
Authorization: Bearer {{adminToken}}
Idempotency-Key: {{scheduleGenerationKey}}
Content-Type: application/json
```

```json
{
  "allocationIds": ["{{allocationId2}}"]
}
```

Sa After response:

```javascript
const schedule = pm.response.json().data.schedules[0];
pm.environment.set("scheduleId2", schedule.scheduleId);
```

Expected:

- `201 Created`;
- header `Idempotency-Replayed: false`;
- Allocation B naa sa Slot 1;
- `queueNumber: 2`;
- `assignedByAi: true`;
- Slot 1 mahimong `FULL` kay duha na ang schedules.

### Step 15 — Idempotent replay

Ayaw usba ang key ug body. Isend balik ang Step 14.

Expected:

- `201 Created`;
- header `Idempotency-Replayed: true`;
- parehas nga `scheduleId2`;
- walay duplicate schedule.

### Step 16 — Reused-key body mismatch

Same `scheduleGenerationKey`, pero ilisi temporary ang body:

```json
{
  "allocationIds": ["{{allocationId3}}"]
}
```

Expected: `409 IDEMPOTENCY_KEY_REUSED`. Human ani, ibalik ang old body kung kinahanglan nimo i-review ang replay.

### Step 17 — Capacity/full-slot protection

Sulayi og manual assign ang Allocation C ngadto sa full Slot 1:

```http
POST {{baseUrl}}/distributions/{{distributionId}}/schedules
Authorization: Bearer {{adminToken}}
Content-Type: application/json
```

```json
{
  "allocationId": "{{allocationId3}}",
  "slotId": "{{slotId1}}"
}
```

Expected: `409 DISTRIBUTION_SLOT_NOT_AVAILABLE` o `409 DISTRIBUTION_SLOT_CAPACITY_EXCEEDED`. Walay schedule nga mahimo para sa Allocation C.

### Step 18 — Reschedule Allocation A ngadto sa Slot 2

```http
POST {{baseUrl}}/distributions/{{distributionId}}/schedules/{{scheduleId1}}/reschedule
Authorization: Bearer {{adminToken}}
Content-Type: application/json
```

```json
{
  "slotId": "{{slotId2}}"
}
```

Expected:

- `200 OK`;
- schedule naa na sa `slotId2`;
- `queueNumber: 1` sa Slot 2;
- Slot 1 mobalik `AVAILABLE` kay usa na lang ang occupant.

### Step 19 — Cancel Schedule A

```http
POST {{baseUrl}}/distributions/{{distributionId}}/schedules/{{scheduleId1}}/cancel
Authorization: Bearer {{adminToken}}
```

Expected: `200 OK`, `status: CANCELLED`. Isend balik; expected `409 INVALID_DISTRIBUTION_SCHEDULE_TRANSITION`.

### Step 20 — Opening must fail while incomplete

```http
POST {{baseUrl}}/distributions/{{distributionId}}/open
Authorization: Bearer {{adminToken}}
```

Expected: `409 DISTRIBUTION_ALLOCATIONS_UNSCHEDULED` kay cancelled si Schedule A ug wala pay schedule si Allocation C.

Importante: i-check nga ang distribution nagpabilin `DRAFT`.

### Step 21 — Reactivate Schedule A

```http
POST {{baseUrl}}/distributions/{{distributionId}}/schedules/{{scheduleId1}}/reactivate
Authorization: Bearer {{adminToken}}
```

Expected: `200 OK`, `status: SCHEDULED`, same Slot 2 ug same queue number.

### Step 22 — Schedule Allocation C ngadto sa Slot 1

```http
POST {{baseUrl}}/distributions/{{distributionId}}/schedules
Authorization: Bearer {{adminToken}}
Content-Type: application/json
```

```json
{
  "allocationId": "{{allocationId3}}",
  "slotId": "{{slotId1}}"
}
```

Sa After response:

```javascript
const schedule = pm.response.json().data.schedule;
pm.environment.set("scheduleId3", schedule.scheduleId);
```

Expected: `201 Created`. Sa exact sequence, expected queue number `3` kay naa gihapon ang queue number `2` sa Slot 1 ug ang next number mao ang `3`.

### Step 23 — DSWD global monitoring

```http
GET {{baseUrl}}/distributions/{{distributionId}}/schedules?status=SCHEDULED&page=1&pageSize=20
Authorization: Bearer {{dswdToken}}
```

Expected: `200 OK`, three active schedules, summary, ug pagination.

Search test:

```http
GET {{baseUrl}}/distributions/{{distributionId}}/schedules?search=1&page=1&pageSize=20
Authorization: Bearer {{dswdToken}}
```

Expected: `200 OK`; ang `search=1` mahimong queue-number search.

### Step 24 — Barangay-scoped read

```http
GET {{baseUrl}}/distributions/{{distributionId}}/schedules?page=1&pageSize=20
Authorization: Bearer {{barangayToken}}
```

Expected: `200 OK` kung ang event naa sa facilitator's assigned Barangay. Kung lain nga Barangay ang event, expected `404 DISTRIBUTION_NOT_FOUND`.

### Step 25 — Read one schedule and inspect privacy

```http
GET {{baseUrl}}/distributions/{{distributionId}}/schedules/{{scheduleId1}}
Authorization: Bearer {{dswdToken}}
```

Expected: `200 OK`. Sa response, siguroa nga wala kini:

```text
address
contactNumber
email
philsysNumber
passwordHash
totpSecret
documents
biometricData
qrTokens
claims
walletAccount
```

### Step 26 — DSWD cannot open the event

```http
POST {{baseUrl}}/distributions/{{distributionId}}/open
Authorization: Bearer {{dswdToken}}
```

Expected: `403 FORBIDDEN`. Event kinahanglan nagpabilin `DRAFT`.

### Step 27 — Open as System Administrator

Before sending, list schedules one last time and confirm three `SCHEDULED` rows.

```http
POST {{baseUrl}}/distributions/{{distributionId}}/open
Authorization: Bearer {{adminToken}}
```

Expected: `200 OK`, distribution `status: OPEN`.

### Step 28 — Confirm post-open freeze

Sulayi pag-cancel si Schedule A:

```http
POST {{baseUrl}}/distributions/{{distributionId}}/schedules/{{scheduleId1}}/cancel
Authorization: Bearer {{adminToken}}
```

Expected: `409 DISTRIBUTION_SCHEDULES_NOT_EDITABLE`.

Sulayi usab og manual schedule, batch generation, reschedule, allocation mutation, ug slot mutation. Expected tanan mutations ma-block kay `OPEN` na ang event.

### Step 29 — Audit-log check

```http
GET {{baseUrl}}/audit-logs?entityAffected=SCHEDULE&recordId={{scheduleId1}}&page=1&pageSize=20
Authorization: Bearer {{dswdToken}}
```

Expected actions para sa Schedule A:

```text
DISTRIBUTION_SCHEDULE_CREATED
DISTRIBUTION_SCHEDULE_RESCHEDULED
DISTRIBUTION_SCHEDULE_CANCELLED
DISTRIBUTION_SCHEDULE_REACTIVATED
```

Check ang event audit:

```http
GET {{baseUrl}}/audit-logs?action=DISTRIBUTION_OPENED&recordId={{distributionId}}
Authorization: Bearer {{dswdToken}}
```

Expected: one `DISTRIBUTION_OPENED` record.

## F. Automated confirmation after Postman

Sa terminal:

```powershell
npm.cmd test
npm.cmd run prisma:validate
npm.cmd run verify:distribution:schedules
```

Expected:

```text
113 tests passed
Prisma schema is valid
Phase 4 distribution scheduling verification passed
```

Ang verification script temporary records ra ang gamiton ug limpyohan dayon. Dili kini mo-reset o mo-recreate sa database.

## Common mistakes

- `401`: expired/missing token o sayop ang TOTP; login balik.
- `403`: DSWD/Barangay token gigamit sa mutation; Admin token ang gamita.
- `404 DISTRIBUTION_NOT_FOUND`: wrong UUID o Barangay facilitator dili assigned sa event Barangay.
- `409 DISTRIBUTION_SCHEDULES_NOT_EDITABLE`: dili na `DRAFT` ang event.
- `409 ALLOCATION_NOT_SCHEDULABLE`: allocation dili `ALLOCATED`.
- `409 BENEFICIARY_ALREADY_SCHEDULED`: naa nay schedule bisan `CANCELLED`; gamita ang reactivate endpoint.
- `409 DISTRIBUTION_SLOT_NOT_AVAILABLE`: `FULL` o `CLOSED` ang slot.
- `409 IDEMPOTENCY_KEY_REUSED`: same key pero nausab ang body; generate a new UUID for a new request.
- `409 DISTRIBUTION_ALLOCATIONS_UNSCHEDULED`: dili pa tanan active allocations adunay active schedule.
- Ayaw i-cancel ang distribution before mahuman ang tests; terminal state ang `CANCELLED` ug dili na ma-reactivate.
