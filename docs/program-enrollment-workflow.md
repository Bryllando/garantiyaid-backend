# Staff Web Program and Beneficiary Enrollment Workflow

This workflow is for the authenticated staff web application only. A beneficiary is a managed record, not a login account.

## Role boundaries

| Action | SYSTEM_ADMIN | DSWD_STAFF | BARANGAY_FACILITATOR |
|---|---:|---:|---:|
| Read programs and enrollments | Yes | Yes | Yes, assigned barangay only |
| Create/edit/activate/close programs and criteria | No | Yes | No |
| Create and update beneficiary records | Yes | No | Yes, assigned barangay only |
| Upload beneficiary documents | No | No | Yes, assigned barangay only |
| Submit/resubmit beneficiary enrollment | No | No | Yes, assigned barangay only |
| Start review/request correction/approve/reject | No | Yes | No |

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
