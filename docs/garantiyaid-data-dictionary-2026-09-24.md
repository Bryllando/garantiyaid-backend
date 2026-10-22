# GarantiyAid current data dictionary

Generated from `prisma/schema.prisma` on 24 September 2026. The schema, not the earlier 22-entity image, is the implementation source. This catalog lists all 32 Prisma models and their stored scalar/enum fields. Relation properties are omitted because their foreign-key columns appear below. Nullable `?` and arrays `[]` follow Prisma notation. Sensitive values such as password hashes, reset-token hashes, QR hashes, encrypted biometric templates, signatures, and contact details must not appear in public exports or screenshots.

## User

Staff identity, role, assignment, and authentication state. Physical table: `users`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `userId` | `String` | column `user_id`; PK; default `uuid()` |
| `employeeId` | `String` | column `employee_id`; unique |
| `username` | `String?` | unique; nullable |
| `fullName` | `String` | column `full_name` |
| `email` | `String` | unique |
| `passwordHash` | `String` | column `password_hash` |
| `mustChangePassword` | `Boolean` | column `must_change_password`; default `true` |
| `totpSecret` | `String?` | column `totp_secret`; nullable |
| `totpEnabled` | `Boolean` | column `totp_enabled`; default `false` |
| `lastTotpCounter` | `BigInt?` | column `last_totp_counter`; nullable |
| `otpCodeHash` | `String?` | column `otp_code_hash`; nullable |
| `otpExpiresAt` | `DateTime?` | column `otp_expires_at`; nullable |
| `failedLoginAttempts` | `Int` | column `failed_login_attempts`; default `0` |
| `lastFailedLoginAt` | `DateTime?` | column `last_failed_login_at`; nullable |
| `lockedUntil` | `DateTime?` | column `locked_until`; nullable |
| `role` | `UserRole` | required |
| `contactNumber` | `String?` | column `contact_number`; nullable |
| `barangayId` | `String?` | column `barangay_id`; FK; nullable |
| `isActive` | `Boolean` | column `is_active`; default `true` |
| `archivedAt` | `DateTime?` | column `archived_at`; nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

Composite constraints: `@@index([archivedAt])`.

## StaffSession

Revocable staff sign-in session. Physical table: `staff_sessions`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `sessionId` | `String` | column `session_id`; PK |
| `userId` | `String` | column `user_id`; FK |
| `expiresAt` | `DateTime` | column `expires_at` |
| `revokedAt` | `DateTime?` | column `revoked_at`; nullable |
| `ipAddress` | `String?` | column `ip_address`; nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |

Composite constraints: `@@index([userId, revokedAt])`; `@@index([expiresAt])`.

## StaffPasswordResetToken

Single-use hashed staff password-reset token. Physical table: `staff_password_reset_tokens`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `resetTokenId` | `String` | column `reset_token_id`; PK; default `uuid()` |
| `userId` | `String` | column `user_id`; FK |
| `tokenHash` | `String` | column `token_hash`; unique |
| `expiresAt` | `DateTime` | column `expires_at` |
| `usedAt` | `DateTime?` | column `used_at`; nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |

Composite constraints: `@@index([userId, usedAt])`; `@@index([expiresAt])`.

## StaffRecoveryCode

Hashed second-factor recovery code. Physical table: `staff_recovery_codes`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `recoveryCodeId` | `String` | column `recovery_code_id`; PK; default `uuid()` |
| `userId` | `String` | column `user_id`; FK |
| `codeHash` | `String` | column `code_hash`; unique |
| `usedAt` | `DateTime?` | column `used_at`; nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |

Composite constraints: `@@index([userId, usedAt])`.

## IdempotencyRecord

Request replay protection for sensitive mutations. Physical table: `idempotency_records`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `idempotencyRecordId` | `String` | column `idempotency_record_id`; PK; default `uuid()` |
| `userId` | `String` | column `user_id`; FK |
| `operation` | `String` | required |
| `idempotencyKey` | `String` | column `idempotency_key` |
| `requestHash` | `String` | column `request_hash` |
| `responseStatus` | `Int` | column `response_status` |
| `responseBody` | `Json` | column `response_body` |
| `expiresAt` | `DateTime` | column `expires_at` |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |

Composite constraints: `@@unique([userId, operation, idempotencyKey])`; `@@index([expiresAt])`.

## Barangay

Service area and facilitator scope. Physical table: `barangays`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `barangayId` | `String` | column `barangay_id`; PK; default `uuid()` |
| `barangayCode` | `String?` | column `barangay_code`; unique; nullable |
| `barangayName` | `String` | column `barangay_name` |
| `city` | `String` | required |
| `province` | `String` | required |
| `isActive` | `Boolean` | column `is_active`; default `true` |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

## Program

Assistance program, amount, budget, and lifecycle. Physical table: `programs`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `programId` | `String` | column `program_id`; PK; default `uuid()` |
| `programName` | `String` | column `program_name` |
| `programCode` | `String` | column `program_code`; unique |
| `programType` | `String` | column `program_type` |
| `description` | `String?` | nullable |
| `grantAmount` | `Decimal?` | column `grant_amount`; nullable |
| `budgetAmount` | `Decimal?` | column `budget_amount`; nullable |
| `applicationStartDate` | `DateTime?` | column `application_start_date`; nullable |
| `applicationEndDate` | `DateTime?` | column `application_end_date`; nullable |
| `requiredDocumentTypes` | `String[]` | column `required_document_types`; default `[]` |
| `status` | `ProgramStatus` | default `DRAFT` |
| `createdById` | `String` | column `created_by`; FK |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

Composite constraints: `@@index([status])`.

## ProgramCriterion

Eligibility rule attached to a program. Physical table: `program_criteria`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `criterionId` | `String` | column `criterion_id`; PK; default `uuid()` |
| `programId` | `String` | column `program_id`; FK |
| `criterionName` | `String` | column `criterion_name` |
| `fieldName` | `String` | column `field_name` |
| `operator` | `String` | required |
| `expectedValue` | `Json` | column `expected_value` |
| `isRequired` | `Boolean` | column `is_required`; default `true` |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

## Beneficiary

Person receiving or applying for assistance. Physical table: `beneficiaries`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `beneficiaryId` | `String` | column `beneficiary_id`; PK; default `uuid()` |
| `firstName` | `String` | column `first_name` |
| `middleName` | `String?` | column `middle_name`; nullable |
| `lastName` | `String` | column `last_name` |
| `birthDate` | `DateTime` | column `birth_date` |
| `sex` | `String` | required |
| `address` | `String` | required |
| `sitioPurok` | `String?` | column `sitio_purok`; nullable |
| `barangayId` | `String` | column `barangay_id`; FK |
| `contactNumber` | `String?` | column `contact_number`; nullable |
| `email` | `String?` | unique; nullable |
| `passwordHash` | `String?` | column `password_hash`; nullable |
| `isVerified` | `Boolean` | column `is_verified`; default `false` |
| `philsysNumber` | `String?` | column `philsys_number`; unique; nullable |
| `status` | `String` | default `"ACTIVE"` |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

## Enrollment

Beneficiary application and eligibility decision for a program. Physical table: `enrollments`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `enrollmentId` | `String` | column `enrollment_id`; PK; default `uuid()` |
| `beneficiaryId` | `String` | column `beneficiary_id`; FK |
| `programId` | `String` | column `program_id`; FK |
| `submittedById` | `String` | column `submitted_by`; FK |
| `enrollmentDate` | `DateTime` | column `enrollment_date`; default `now()` |
| `status` | `EnrollmentStatus` | default `PENDING` |
| `reviewedById` | `String?` | column `reviewed_by`; FK; nullable |
| `reviewNotes` | `String?` | column `review_notes`; nullable |
| `reviewedAt` | `DateTime?` | column `reviewed_at`; nullable |
| `eligibilitySnapshot` | `Json?` | column `eligibility_snapshot`; nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

Composite constraints: `@@unique([beneficiaryId, programId])`; `@@index([programId, status])`; `@@index([status])`.

## BeneficiaryDocument

Uploaded evidence and review/replacement history. Physical table: `beneficiary_documents`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `documentId` | `String` | column `document_id`; PK; default `uuid()` |
| `beneficiaryId` | `String` | column `beneficiary_id`; FK |
| `uploadedById` | `String` | column `uploaded_by`; FK |
| `documentType` | `String` | column `doc_type` |
| `originalFileName` | `String` | column `original_file_name` |
| `mimeType` | `String` | column `mime_type` |
| `fileSize` | `Int` | column `file_size` |
| `checksum` | `String` | required |
| `filePath` | `String` | column `file_path` |
| `reviewStatus` | `DocumentReviewStatus` | column `review_status`; default `SUBMITTED` |
| `reviewedById` | `String?` | column `reviewed_by`; FK; nullable |
| `reviewedAt` | `DateTime?` | column `reviewed_at`; nullable |
| `reviewNotes` | `String?` | column `review_notes`; nullable |
| `replacesDocumentId` | `String?` | column `replaces_document_id`; unique; FK; nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |

Composite constraints: `@@index([beneficiaryId, documentType])`; `@@index([beneficiaryId, documentType, reviewStatus])`.

## BiometricConsent

Time-bound consent and retention decision. Physical table: `biometric_consents`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `consentId` | `String` | column `consent_id`; PK; default `uuid()` |
| `beneficiaryId` | `String` | column `beneficiary_id`; FK |
| `consentVersion` | `String` | column `consent_version` |
| `consentGiven` | `Boolean` | column `consent_given` |
| `consentedAt` | `DateTime` | column `consented_at` |
| `revokedAt` | `DateTime?` | column `revoked_at`; nullable |
| `retentionUntil` | `DateTime` | column `retention_until` |
| `recordedById` | `String` | column `recorded_by`; FK |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

## BiometricData

Encrypted face embedding and enrollment state. Physical table: `biometric_data`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `biometricId` | `String` | column `biometric_id`; PK; default `uuid()` |
| `beneficiaryId` | `String` | column `beneficiary_id`; unique; FK |
| `enrolledById` | `String` | column `enrolled_by`; FK |
| `consentId` | `String` | column `consent_id`; unique; FK |
| `faceEmbedding` | `Bytes` | column `face_embedding` |
| `insightfaceModel` | `String` | column `insightface_model` |
| `dataStatus` | `BiometricDataStatus` | column `data_status`; default `ACTIVE` |
| `livenessScore` | `Decimal?` | column `liveness_score`; nullable |
| `livenessPassed` | `Boolean?` | column `liveness_passed`; nullable |
| `verificationCount` | `Int` | column `verification_count`; default `0` |
| `lastVerifiedAt` | `DateTime?` | column `last_verified_at`; nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

## BiometricDuplicateCase

Possible cross-record face match requiring independent review. Physical table: `biometric_duplicate_cases`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `duplicateCaseId` | `String` | column `duplicate_case_id`; PK; default `uuid()` |
| `candidateBeneficiaryId` | `String` | column `candidate_beneficiary_id`; FK |
| `matchedBeneficiaryId` | `String` | column `matched_beneficiary_id`; FK |
| `candidateBiometricId` | `String?` | column `candidate_biometric_id`; FK; nullable |
| `matchedBiometricId` | `String?` | column `matched_biometric_id`; FK; nullable |
| `matchScore` | `Decimal` | column `match_score` |
| `matchThreshold` | `Decimal` | column `match_threshold` |
| `status` | `BiometricDuplicateCaseStatus` | default `PENDING` |
| `detectedAt` | `DateTime` | column `detected_at`; default `now()` |
| `reviewedById` | `String?` | column `reviewed_by`; FK; nullable |
| `reviewedAt` | `DateTime?` | column `reviewed_at`; nullable |
| `reviewNotes` | `String?` | column `review_notes`; nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

Composite constraints: `@@index([status, detectedAt])`; `@@index([candidateBeneficiaryId, status])`; `@@index([matchedBeneficiaryId, status])`.

## BiometricVerificationAttempt

Claim verification outcome and processor metadata. Physical table: `biometric_verification_attempts`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `attemptId` | `String` | column `attempt_id`; PK; default `uuid()` |
| `distributionId` | `String?` | column `distribution_id`; FK; nullable |
| `beneficiaryId` | `String` | column `beneficiary_id`; FK |
| `biometricId` | `String?` | column `biometric_id`; FK; nullable |
| `claimId` | `String?` | column `claim_id`; FK; nullable |
| `verifiedById` | `String` | column `verified_by`; FK |
| `result` | `String` | required |
| `matchScore` | `Decimal?` | column `match_score`; nullable |
| `livenessScore` | `Decimal?` | column `liveness_score`; nullable |
| `deviceInfo` | `String?` | column `device_info`; nullable |
| `processor` | `String` | required |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |

Composite constraints: `@@index([distributionId, result, createdAt])`; `@@index([beneficiaryId, createdAt])`.

## WalletAccount

Closed-loop simulated beneficiary balance. Physical table: `wallet_accounts`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `walletId` | `String` | column `wallet_id`; PK; default `uuid()` |
| `beneficiaryId` | `String` | column `beneficiary_id`; unique; FK |
| `balance` | `Decimal` | default `0` |
| `currency` | `String` | default `"PHP"` |
| `accountStatus` | `String` | column `account_status`; default `"ACTIVE"` |
| `lastTransactionAt` | `DateTime?` | column `last_transaction_at`; nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

## Distribution

Assistance event and physical or simulated delivery mode. Physical table: `distributions`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `distributionId` | `String` | column `distribution_id`; PK; default `uuid()` |
| `programId` | `String` | column `program_id`; FK |
| `createdById` | `String` | column `created_by`; FK |
| `title` | `String` | required |
| `distributionDate` | `DateTime` | column `distribution_date` |
| `startTime` | `DateTime` | column `start_time` |
| `endTime` | `DateTime` | column `end_time` |
| `slotDurationMinutes` | `Int` | column `slot_duration_mins` |
| `location` | `String` | required |
| `barangayId` | `String` | column `barangay_id`; FK |
| `status` | `DistributionStatus` | default `DRAFT` |
| `deliveryMode` | `AssistanceDeliveryMode` | column `delivery_mode`; default `SIMULATED_WALLET` |
| `verificationRequirement` | `VerificationMethod` | column `verification_requirement`; default `QR` |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

## DistributionSlot

Event session, location, service area, and capacity. Physical table: `distribution_slots`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `slotId` | `String` | column `slot_id`; PK; default `uuid()` |
| `distributionId` | `String` | column `distribution_id`; FK |
| `sessionId` | `String` | column `session_id` |
| `sessionLabel` | `String` | column `session_label` |
| `location` | `String` | required |
| `serviceAreas` | `String[]` | column `service_areas`; default `[]` |
| `slotStart` | `DateTime` | column `slot_start` |
| `slotEnd` | `DateTime` | column `slot_end` |
| `capacity` | `Int` | required |
| `slotStatus` | `DistributionSlotStatus` | column `slot_status`; default `AVAILABLE` |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

Composite constraints: `@@unique([distributionId, slotStart])`; `@@index([distributionId, slotStatus, slotStart])`; `@@index([distributionId, sessionId, slotStart])`.

## DistributionAllocation

Beneficiary place in a distribution event. Physical table: `distribution_allocations`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `allocationId` | `String` | column `allocation_id`; PK; default `uuid()` |
| `distributionId` | `String` | column `distribution_id`; FK |
| `beneficiaryId` | `String` | column `beneficiary_id`; FK |
| `enrollmentId` | `String` | column `enrollment_id`; FK |
| `amount` | `Decimal` | required |
| `allocationStatus` | `AllocationStatus` | column `allocation_status`; default `PENDING` |
| `allocatedById` | `String` | column `allocated_by`; FK |
| `allocatedAt` | `DateTime` | column `allocated_at` |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

Composite constraints: `@@unique([distributionId, beneficiaryId])`; `@@unique([distributionId, enrollmentId])`; `@@index([distributionId, allocationStatus, createdAt])`; `@@index([enrollmentId])`.

## Schedule

Allocation appointment and queue number. Physical table: `schedules`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `scheduleId` | `String` | column `schedule_id`; PK; default `uuid()` |
| `distributionId` | `String` | column `distribution_id`; FK |
| `beneficiaryId` | `String` | column `beneficiary_id`; FK |
| `slotId` | `String` | column `slot_id`; FK |
| `queueNumber` | `Int` | column `queue_number` |
| `status` | `ScheduleStatus` | default `SCHEDULED` |
| `assignedByAi` | `Boolean` | column `assigned_by_ai`; default `false` |
| `notificationAt` | `DateTime?` | column `notification_at`; nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

Composite constraints: `@@unique([distributionId, beneficiaryId])`; `@@unique([slotId, queueNumber])`.

## QrToken

Hashed one-time QR credential. Physical table: `qr_tokens`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `qrTokenId` | `String` | column `qr_token_id`; PK; default `uuid()` |
| `beneficiaryId` | `String` | column `beneficiary_id`; FK |
| `distributionId` | `String` | column `distribution_id`; FK |
| `tokenHash` | `String` | column `token_hash`; unique |
| `qrStatus` | `QrTokenStatus` | column `qr_status`; default `ACTIVE` |
| `expiresAt` | `DateTime` | column `expire_at` |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |

Composite constraints: `@@unique([beneficiaryId, distributionId])`; `@@index([distributionId, qrStatus, expiresAt])`.

## QrScanLog

QR attempt result and scanning actor. Physical table: `qr_scan_logs`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `scanLogId` | `String` | column `scan_log_id`; PK; default `uuid()` |
| `distributionId` | `String?` | column `distribution_id`; FK; nullable |
| `qrTokenId` | `String?` | column `qr_token_id`; FK; nullable |
| `submittedTokenHash` | `String?` | column `submitted_token_hash`; nullable |
| `claimId` | `String?` | column `claim_id`; FK; nullable |
| `scannedById` | `String` | column `scanned_by`; FK |
| `scanResult` | `String` | column `scan_result` |
| `deviceInfo` | `String?` | column `device_info`; nullable |
| `scannedAt` | `DateTime` | column `scanned_at`; default `now()` |

Composite constraints: `@@index([distributionId, scanResult, scannedAt])`; `@@index([qrTokenId, scannedAt])`; `@@index([submittedTokenHash, scannedAt])`; `@@index([scanResult, scannedAt])`.

## Claim

Verified/released/settled assistance claim. Physical table: `claims`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `claimId` | `String` | column `claim_id`; PK; default `uuid()` |
| `beneficiaryId` | `String` | column `beneficiary_id`; FK |
| `distributionId` | `String` | column `distribution_id`; FK |
| `scheduleId` | `String` | column `schedule_id`; unique; FK |
| `verifiedById` | `String?` | column `verified_by`; FK; nullable |
| `allocationId` | `String` | column `allocation_id`; unique; FK |
| `claimStatus` | `ClaimStatus` | column `claim_status`; default `PENDING` |
| `verificationMethod` | `VerificationMethod` | column `verification_method`; default `QR` |
| `biometricVerified` | `Boolean` | column `biometric_verified`; default `false` |
| `biometricScore` | `Decimal?` | column `biometric_score`; nullable |
| `qrVerified` | `Boolean` | column `qr_verified`; default `false` |
| `signatureVerified` | `Boolean` | column `signature_verified`; default `false` |
| `isDuplicateFlag` | `Boolean` | column `is_duplicate_flag`; default `false` |
| `releaseMethod` | `AssistanceDeliveryMode?` | column `release_method`; nullable |
| `releasedById` | `String?` | column `released_by`; FK; nullable |
| `releasedAt` | `DateTime?` | column `released_at`; nullable |
| `releaseEvidenceType` | `ReleaseEvidenceType?` | column `release_evidence_type`; nullable |
| `releaseEvidenceReference` | `String?` | column `release_evidence_reference`; nullable |
| `releaseNotes` | `String?` | column `release_notes`; nullable |
| `claimedAt` | `DateTime?` | column `claimed_at`; nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

Composite constraints: `@@unique([beneficiaryId, distributionId])`; `@@index([distributionId, claimStatus, createdAt])`; `@@index([releasedById, releasedAt])`.

## ClaimSignature

Encrypted signature fallback evidence. Physical table: `claim_signatures`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `signatureId` | `String` | column `signature_id`; PK; default `uuid()` |
| `claimId` | `String` | column `claim_id`; unique; FK |
| `capturedById` | `String` | column `captured_by`; FK |
| `encryptedImage` | `Bytes` | column `encrypted_image` |
| `imageSha256` | `String` | column `image_sha256` |
| `signatureMethod` | `String` | column `signature_method`; default `"DRAWN"` |
| `pointCount` | `Int?` | column `point_count`; nullable |
| `deviceInfo` | `String?` | column `device_info`; nullable |
| `signedAt` | `DateTime` | column `signed_at`; default `now()` |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |

Composite constraints: `@@index([capturedById, signedAt])`.

## ClaimReceipt

Issuable snapshot of final claim evidence. Physical table: `claim_receipts`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `receiptId` | `String` | column `receipt_id`; PK; default `uuid()` |
| `claimId` | `String` | column `claim_id`; unique; FK |
| `issuedById` | `String` | column `issued_by`; FK |
| `receiptNo` | `String` | column `receipt_no`; unique |
| `receiptVersion` | `String` | column `receipt_version`; default `"GYA-CLAIM-1"` |
| `evidenceHash` | `String` | column `evidence_hash` |
| `snapshot` | `Json` | required |
| `printCount` | `Int` | column `print_count`; default `0` |
| `lastPrintedAt` | `DateTime?` | column `last_printed_at`; nullable |
| `issuedAt` | `DateTime` | column `issued_at`; default `now()` |

Composite constraints: `@@index([issuedById, issuedAt])`.

## ClaimDispute

Contested claim and review outcome. Physical table: `claim_disputes`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `disputeId` | `String` | column `dispute_id`; PK; default `uuid()` |
| `claimId` | `String` | column `claim_id`; FK |
| `filedById` | `String` | column `filed_by`; FK |
| `assignedToId` | `String?` | column `assigned_to`; FK; nullable |
| `reviewedById` | `String?` | column `reviewed_by`; FK; nullable |
| `referenceNo` | `String` | column `reference_no`; unique |
| `status` | `ClaimDisputeStatus` | default `OPEN` |
| `reasonCode` | `ClaimDisputeReason` | column `reason_code` |
| `statement` | `String` | required |
| `outcome` | `ClaimDisputeOutcome?` | nullable |
| `reviewNotes` | `String?` | column `review_notes`; nullable |
| `filedAt` | `DateTime` | column `filed_at`; default `now()` |
| `reviewedAt` | `DateTime?` | column `reviewed_at`; nullable |
| `resolvedAt` | `DateTime?` | column `resolved_at`; nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

Composite constraints: `@@index([claimId, status, filedAt])`; `@@index([status, filedAt])`; `@@index([assignedToId, status])`.

## Transaction

Simulated wallet credit/debit/transfer/reversal ledger entry. Physical table: `transactions`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `transactionId` | `String` | column `transaction_id`; PK; default `uuid()` |
| `claimId` | `String?` | column `claim_id`; FK; nullable |
| `distributionId` | `String?` | column `distribution_id`; FK; nullable |
| `walletId` | `String` | column `wallet_id`; FK |
| `beneficiaryId` | `String` | column `beneficiary_id`; FK |
| `initiatedById` | `String?` | column `initiated_by`; FK; nullable |
| `amount` | `Decimal` | required |
| `transactionType` | `String` | column `transaction_type` |
| `referenceNo` | `String` | column `reference_no`; unique |
| `status` | `TransactionStatus` | default `PENDING` |
| `balanceBefore` | `Decimal` | column `balance_before` |
| `balanceAfter` | `Decimal` | column `balance_after` |
| `transferGroupId` | `String?` | column `transfer_group_id`; nullable |
| `reversalOfId` | `String?` | column `reversal_of_id`; unique; FK; nullable |
| `description` | `String?` | nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

Composite constraints: `@@index([distributionId, status, createdAt])`; `@@index([walletId, createdAt])`; `@@index([claimId, transactionType])`; `@@index([transferGroupId])`.

## Notification

Queued, sent, or failed beneficiary message. Physical table: `notifications`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `notificationId` | `String` | column `notification_id`; PK; default `uuid()` |
| `beneficiaryId` | `String` | column `beneficiary_id`; FK |
| `scheduleId` | `String?` | column `schedule_id`; FK; nullable |
| `distributionId` | `String?` | column `distribution_id`; FK; nullable |
| `initiatedById` | `String?` | column `initiated_by`; FK; nullable |
| `channel` | `NotificationChannel` | required |
| `message` | `String` | required |
| `notificationType` | `String` | column `notification_type` |
| `status` | `NotificationStatus` | default `PENDING` |
| `providerMode` | `String` | column `provider_mode`; default `"SIMULATED"` |
| `providerReference` | `String?` | column `provider_reference`; unique; nullable |
| `simulated` | `Boolean` | default `true` |
| `deduplicationKey` | `String?` | column `deduplication_key`; unique; nullable |
| `attemptCount` | `Int` | column `attempt_count`; default `0` |
| `lastErrorCode` | `String?` | column `last_error_code`; nullable |
| `scheduledFor` | `DateTime?` | column `scheduled_for`; nullable |
| `processingToken` | `String?` | column `processing_token`; nullable |
| `processingStartedAt` | `DateTime?` | column `processing_started_at`; nullable |
| `sentAt` | `DateTime?` | column `sent_at`; nullable |
| `failedAt` | `DateTime?` | column `failed_at`; nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

Composite constraints: `@@index([beneficiaryId, createdAt])`; `@@index([scheduleId, createdAt])`; `@@index([distributionId, status, createdAt])`; `@@index([status, scheduledFor])`; `@@index([notificationType, createdAt])`.

## StaffNotification

Staff inbox event. Physical table: `staff_notifications`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `notificationId` | `String` | column `notification_id`; PK; default `uuid()` |
| `userId` | `String` | column `user_id`; FK |
| `notificationType` | `String` | column `notification_type` |
| `title` | `String` | required |
| `message` | `String` | required |
| `targetPath` | `String?` | column `target_path`; nullable |
| `deduplicationKey` | `String?` | column `deduplication_key`; nullable |
| `emailProviderMode` | `String` | column `email_provider_mode`; default `"DISABLED"` |
| `emailRecipient` | `String?` | column `email_recipient`; nullable |
| `emailStatus` | `String` | column `email_status`; default `"NOT_REQUESTED"` |
| `emailProviderReference` | `String?` | column `email_provider_reference`; nullable |
| `emailAttemptCount` | `Int` | column `email_attempt_count`; default `0` |
| `emailLastErrorCode` | `String?` | column `email_last_error_code`; nullable |
| `emailProcessingToken` | `String?` | column `email_processing_token`; nullable |
| `emailProcessingStartedAt` | `DateTime?` | column `email_processing_started_at`; nullable |
| `emailSentAt` | `DateTime?` | column `email_sent_at`; nullable |
| `emailFailedAt` | `DateTime?` | column `email_failed_at`; nullable |
| `readAt` | `DateTime?` | column `read_at`; nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |

Composite constraints: `@@unique([userId, deduplicationKey])`; `@@index([userId, readAt, createdAt])`; `@@index([emailStatus, createdAt])`.

## ChatbotSession

Public help conversation, linkage, ownership, and status. Physical table: `chatbot_sessions`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `sessionId` | `String` | column `session_id`; PK; default `uuid()` |
| `beneficiaryId` | `String?` | column `beneficiary_id`; FK; nullable |
| `accessTokenHash` | `String?` | column `access_token_hash`; unique; nullable |
| `language` | `String?` | nullable |
| `status` | `ChatbotSessionStatus` | default `ACTIVE` |
| `isEscalated` | `Boolean` | column `is_escalated`; default `false` |
| `escalationReason` | `String?` | column `escalation_reason`; nullable |
| `escalatedAt` | `DateTime?` | column `escalated_at`; nullable |
| `assignedStaffId` | `String?` | column `assigned_staff_id`; FK; nullable |
| `assignedAt` | `DateTime?` | column `assigned_at`; nullable |
| `resolvedById` | `String?` | column `resolved_by_id`; FK; nullable |
| `resolvedAt` | `DateTime?` | column `resolved_at`; nullable |
| `resolutionCode` | `String?` | column `resolution_code`; nullable |
| `startedAt` | `DateTime` | column `started_at`; default `now()` |
| `endedAt` | `DateTime?` | column `ended_at`; nullable |
| `lastActivityAt` | `DateTime` | column `last_activity_at`; default `now()` |
| `retentionUntil` | `DateTime` | column `retention_until` |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |
| `updatedAt` | `DateTime` | column `updated_at` |

Composite constraints: `@@index([status, lastActivityAt])`; `@@index([beneficiaryId, status, lastActivityAt])`; `@@index([assignedStaffId, status, lastActivityAt])`; `@@index([retentionUntil])`.

## ChatbotMessage

Redacted conversation or staff reply. Physical table: `chatbot_messages`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `messageId` | `String` | column `message_id`; PK; default `uuid()` |
| `sessionId` | `String` | column `session_id`; FK |
| `sequence` | `Int` | required |
| `senderType` | `ChatbotSenderType` | column `sender_type` |
| `staffUserId` | `String?` | column `staff_user_id`; FK; nullable |
| `messageText` | `String` | column `message_text` |
| `intentDetected` | `String?` | column `intent_detected`; nullable |
| `confidenceScore` | `Decimal?` | column `confidence_score`; nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |

Composite constraints: `@@unique([sessionId, sequence])`; `@@index([sessionId, createdAt, messageId])`; `@@index([staffUserId, createdAt])`.

## AuditLog

Staff action and record change history. Physical table: `audit_logs`.

| Field | Type | Storage and constraint |
| --- | --- | --- |
| `auditId` | `String` | column `audit_id`; PK; default `uuid()` |
| `userId` | `String?` | column `user_id`; FK; nullable |
| `actorType` | `String` | column `actor_type`; default `"STAFF"` |
| `action` | `String` | required |
| `entityAffected` | `String` | column `entity_affected` |
| `recordId` | `String?` | column `record_id`; nullable |
| `ipAddress` | `String?` | column `ip_address`; nullable |
| `details` | `Json?` | nullable |
| `createdAt` | `DateTime` | column `created_at`; default `now()` |

Composite constraints: `@@index([entityAffected, recordId])`; `@@index([createdAt])`.
