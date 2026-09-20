# Staff Web Program and Beneficiary Enrollment Workflow

This workflow is for the authenticated staff web application only. A beneficiary is a managed record, not a login account.

## Staff permission matrix

The web navigation and API use the same boundaries. “Assigned barangay” is enforced by the server even when a request is sent directly to the API.

| Action | SYSTEM_ADMIN | DSWD_STAFF | BARANGAY_FACILITATOR |
|---|---:|---:|---:|
| Browse every program status and read program details | Yes | Yes | Yes |
| Create/edit/publish/close programs and criteria | No | Yes | No |
| Read beneficiary records | Yes | Yes | Assigned barangay |
| Create and update beneficiary records | Yes | No | Assigned barangay |
| Read/download beneficiary documents | Yes | Yes | Assigned barangay |
| Upload or replace beneficiary documents | No | No | Assigned barangay |
| Accept or reject beneficiary documents | No | Yes | No |
| Read enrollments | Yes | Yes | Assigned barangay |
| Submit/resubmit enrollment | No | No | Assigned barangay |
| Start review/request correction/approve/reject enrollment | No | Yes | No |
| Read distribution events, slots, allocations, and schedules | Yes | Yes | Assigned barangay |
| Create/update/cancel/open distribution events | Yes | No | No |
| Generate/update/close distribution slots | Yes | No | No |
| Create/cancel/reactivate allocations | Yes | No | No |
| Generate/create/reschedule/cancel/reactivate schedules | Yes | No | Assigned barangay |
| Verify QR or biometric claims | Yes | No | Assigned barangay |
| Record physical assistance release | No | No | Assigned barangay |
| File claim disputes | Yes | Yes | Assigned barangay |
| Review claim disputes | Yes | Yes | No |
| Read biometric status and consent | Yes | Yes | Assigned barangay |
| Record or revoke biometric consent | Yes | Yes | Assigned barangay |
| Capture/re-enroll and verify biometrics | Yes | No | Assigned barangay |
| Review possible duplicate faces | Yes | Yes | No |
| Permanently delete a biometric template | Yes | No | No |
| Read/manage simulated wallets | Yes | Yes | No |

## Status flows

Program:

```text
DRAFT -> ACTIVE -> CLOSED
   |        |
   +--------+-> CANCELLED
```

Enrollment:

```text
PENDING -> FOR_VALIDATION -> APPROVED
                         |-> REJECTED
                         |-> NEEDS_CORRECTION -> PENDING
```

All requests use the staff access token returned after password and TOTP login:

```http
Authorization: Bearer <ROLE_ACCESS_TOKEN>
```

## 1. DSWD creates a draft assistance program

```http
POST /api/v1/programs
Content-Type: application/json
```

```json
{
  "programName": "Educational Assistance 2026",
  "programCode": "EA-2026",
  "programType": "EDUCATIONAL",
  "description": "Educational support for qualified beneficiaries.",
  "grantAmount": 5000,
  "budgetAmount": 500000,
  "requiredDocumentTypes": ["VALID_ID", "BARANGAY_CERTIFICATE"]
}
```

Application dates are optional. When supplied, use `YYYY-MM-DD`. The end date cannot be earlier than the start date, and an expired program cannot be activated.

Save `data.program.programId` from the response.

## 2. DSWD adds at least one criterion

```http
POST /api/v1/programs/{programId}/criteria
Content-Type: application/json
```

```json
{
  "criterionName": "At least 18 years old",
  "fieldName": "AGE",
  "operator": "GREATER_THAN_OR_EQUAL",
  "expectedValue": 18,
  "isRequired": true
}
```

Supported criterion fields are `AGE`, `SEX`, `BARANGAY_ID`, `DOCUMENT_TYPE`, and `MANUAL_REVIEW`. Criteria document the DSWD validation rules; the DSWD reviewer makes the approval decision in this phase.

## 3. DSWD activates the program

```http
POST /api/v1/programs/{programId}/activate
```

Activation fails if the program has no criterion, invalid dates/budget, or an expired application period.

## 4. Barangay uploads required beneficiary documents

```http
POST /api/v1/beneficiaries/{beneficiaryId}/documents
Content-Type: multipart/form-data
```

Form-data fields:

| Key | Type | Example |
|---|---|---|
| `documentType` | Text | `VALID_ID` |
| `file` | File | `valid-id.pdf` |

Allowed files are PDF, JPG, and PNG up to 5 MB. The server checks the real file signature, stores a randomized server filename, and does not expose the storage path in API responses.

Repeat the upload for each type required by the program. Supported types are:

- `VALID_ID`
- `BIRTH_CERTIFICATE`
- `BARANGAY_CERTIFICATE`
- `PROOF_OF_RESIDENCY`
- `MEDICAL_CERTIFICATE`
- `PWD_ID`
- `SENIOR_CITIZEN_ID`
- `OTHER`

## 5. Barangay submits the beneficiary

```http
POST /api/v1/programs/{programId}/enrollments
Content-Type: application/json
```

```json
{
  "beneficiaryId": "<beneficiary UUID>"
}
```

The beneficiary must be active and belong to the facilitator's assigned barangay. The program must be active and inside its application period, and all required document types must already be uploaded. A beneficiary can have only one enrollment per program.

Save `data.enrollment.enrollmentId` from the response.

## 6. DSWD starts validation

List submitted records:

```http
GET /api/v1/enrollments?status=PENDING
```

Start reviewing one record:

```http
POST /api/v1/enrollments/{enrollmentId}/start-review
```

This changes the status from `PENDING` to `FOR_VALIDATION`.

## 7A. DSWD requests a correction

```http
POST /api/v1/enrollments/{enrollmentId}/request-correction
Content-Type: application/json
```

```json
{
  "reason": "Please upload a readable barangay certificate."
}
```

The Barangay facilitator corrects the beneficiary data or supporting documents, then resubmits:

```http
POST /api/v1/enrollments/{enrollmentId}/resubmit
```

The record returns to `PENDING`, preserving the auditable correction cycle.

## 7B. DSWD approves or rejects

Approve:

```http
POST /api/v1/enrollments/{enrollmentId}/approve
Content-Type: application/json
```

```json
{
  "remarks": "Eligibility and supporting documents validated."
}
```

Reject:

```http
POST /api/v1/enrollments/{enrollmentId}/reject
Content-Type: application/json
```

```json
{
  "reason": "Beneficiary does not meet the program criteria."
}
```

Approval rechecks the required documents. Every create, update, upload, download, submission, correction, and review decision writes an audit-log entry.

## Reusable automated verification

Run the unit/security checks:

```powershell
npm.cmd test
```

Run the real database-backed HTTP role and status flow:

```powershell
npm.cmd run verify:workflow
```

The workflow script uses the existing three active staff roles and an active beneficiary. It creates uniquely named temporary program/enrollment records and removes only those temporary records when the verification finishes.
