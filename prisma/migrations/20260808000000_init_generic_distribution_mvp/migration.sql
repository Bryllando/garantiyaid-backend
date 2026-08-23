-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SYSTEM_ADMIN', 'DSWD_STAFF', 'BARANGAY_FACILITATOR');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DistributionStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DistributionSlotStatus" AS ENUM ('AVAILABLE', 'FULL', 'CLOSED');

-- CreateEnum
CREATE TYPE "AllocationStatus" AS ENUM ('PENDING', 'ALLOCATED', 'CANCELLED', 'CLAIMED');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('SCHEDULED', 'CHECKED_IN', 'MISSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QrTokenStatus" AS ENUM ('ACTIVE', 'USED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PENDING', 'VERIFIED', 'CLAIMED', 'REJECTED', 'VOIDED');

-- CreateEnum
CREATE TYPE "VerificationMethod" AS ENUM ('QR', 'BIOMETRIC', 'MANUAL', 'QR_AND_BIOMETRIC');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'READ');

-- CreateEnum
CREATE TYPE "ChatbotSenderType" AS ENUM ('USER', 'BOT', 'STAFF');

-- CreateTable
CREATE TABLE "users" (
    "user_id" UUID NOT NULL,
    "employee_id" VARCHAR(30) NOT NULL,
    "full_name" VARCHAR(150) NOT NULL,
    "email" VARCHAR(150) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "totp_secret" VARCHAR(255),
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "otp_code_hash" VARCHAR(255),
    "otp_expires_at" TIMESTAMPTZ(6),
    "role" "UserRole" NOT NULL,
    "contact_number" VARCHAR(20),
    "barangay_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "barangays" (
    "barangay_id" UUID NOT NULL,
    "barangay_code" VARCHAR(20),
    "barangay_name" VARCHAR(100) NOT NULL,
    "city" VARCHAR(100) NOT NULL,
    "province" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "barangays_pkey" PRIMARY KEY ("barangay_id")
);

-- CreateTable
CREATE TABLE "programs" (
    "program_id" UUID NOT NULL,
    "program_name" VARCHAR(150) NOT NULL,
    "program_code" VARCHAR(30) NOT NULL,
    "program_type" VARCHAR(20) NOT NULL,
    "description" TEXT,
    "grant_amount" DECIMAL(12,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("program_id")
);

-- CreateTable
CREATE TABLE "program_criteria" (
    "criterion_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "criterion_name" VARCHAR(100) NOT NULL,
    "field_name" VARCHAR(50) NOT NULL,
    "operator" VARCHAR(30) NOT NULL,
    "expected_value" JSONB NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "program_criteria_pkey" PRIMARY KEY ("criterion_id")
);

-- CreateTable
CREATE TABLE "beneficiaries" (
    "beneficiary_id" UUID NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "middle_name" VARCHAR(100),
    "last_name" VARCHAR(100) NOT NULL,
    "birth_date" DATE NOT NULL,
    "sex" VARCHAR(10) NOT NULL,
    "address" TEXT NOT NULL,
    "barangay_id" UUID NOT NULL,
    "contact_number" VARCHAR(20),
    "email" VARCHAR(150),
    "password_hash" VARCHAR(255),
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "philsys_number" VARCHAR(50),
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "beneficiaries_pkey" PRIMARY KEY ("beneficiary_id")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "enrollment_id" UUID NOT NULL,
    "beneficiary_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "enrollment_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'PENDING',
    "approved_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("enrollment_id")
);

-- CreateTable
CREATE TABLE "beneficiary_documents" (
    "document_id" UUID NOT NULL,
    "beneficiary_id" UUID NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "doc_type" VARCHAR(50) NOT NULL,
    "file_path" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "beneficiary_documents_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "biometric_consents" (
    "consent_id" UUID NOT NULL,
    "beneficiary_id" UUID NOT NULL,
    "consent_version" VARCHAR(20) NOT NULL,
    "consent_given" BOOLEAN NOT NULL,
    "consented_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "retention_until" TIMESTAMPTZ(6) NOT NULL,
    "recorded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "biometric_consents_pkey" PRIMARY KEY ("consent_id")
);

-- CreateTable
CREATE TABLE "biometric_data" (
    "biometric_id" UUID NOT NULL,
    "beneficiary_id" UUID NOT NULL,
    "enrolled_by" UUID NOT NULL,
    "consent_id" UUID NOT NULL,
    "face_embedding" BYTEA NOT NULL,
    "insightface_model" VARCHAR(50) NOT NULL,
    "liveness_score" DECIMAL(5,4),
    "liveness_passed" BOOLEAN,
    "verification_count" INTEGER NOT NULL DEFAULT 0,
    "last_verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "biometric_data_pkey" PRIMARY KEY ("biometric_id")
);

-- CreateTable
CREATE TABLE "wallet_accounts" (
    "wallet_id" UUID NOT NULL,
    "beneficiary_id" UUID NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" VARCHAR(5) NOT NULL DEFAULT 'PHP',
    "account_status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "last_transaction_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wallet_accounts_pkey" PRIMARY KEY ("wallet_id")
);

-- CreateTable
CREATE TABLE "distributions" (
    "distribution_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "distribution_date" DATE NOT NULL,
    "start_time" TIME(0) NOT NULL,
    "end_time" TIME(0) NOT NULL,
    "slot_duration_mins" INTEGER NOT NULL,
    "location" VARCHAR(200) NOT NULL,
    "barangay_id" UUID NOT NULL,
    "status" "DistributionStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "distributions_pkey" PRIMARY KEY ("distribution_id")
);

-- CreateTable
CREATE TABLE "distribution_slots" (
    "slot_id" UUID NOT NULL,
    "distribution_id" UUID NOT NULL,
    "slot_start" TIMESTAMPTZ(6) NOT NULL,
    "slot_end" TIMESTAMPTZ(6) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "slot_status" "DistributionSlotStatus" NOT NULL DEFAULT 'AVAILABLE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "distribution_slots_pkey" PRIMARY KEY ("slot_id")
);

-- CreateTable
CREATE TABLE "distribution_allocations" (
    "allocation_id" UUID NOT NULL,
    "distribution_id" UUID NOT NULL,
    "beneficiary_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "allocation_status" "AllocationStatus" NOT NULL DEFAULT 'PENDING',
    "allocated_by" UUID NOT NULL,
    "allocated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "distribution_allocations_pkey" PRIMARY KEY ("allocation_id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "schedule_id" UUID NOT NULL,
    "distribution_id" UUID NOT NULL,
    "beneficiary_id" UUID NOT NULL,
    "slot_id" UUID NOT NULL,
    "queue_number" INTEGER NOT NULL,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'SCHEDULED',
    "assigned_by_ai" BOOLEAN NOT NULL DEFAULT false,
    "notification_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("schedule_id")
);

-- CreateTable
CREATE TABLE "qr_tokens" (
    "qr_token_id" UUID NOT NULL,
    "beneficiary_id" UUID NOT NULL,
    "distribution_id" UUID NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "qr_status" "QrTokenStatus" NOT NULL DEFAULT 'ACTIVE',
    "expire_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qr_tokens_pkey" PRIMARY KEY ("qr_token_id")
);

-- CreateTable
CREATE TABLE "qr_scan_logs" (
    "scan_log_id" UUID NOT NULL,
    "qr_token_id" UUID NOT NULL,
    "claim_id" UUID,
    "scanned_by" UUID NOT NULL,
    "scan_result" VARCHAR(20) NOT NULL,
    "device_info" VARCHAR(255),
    "scanned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qr_scan_logs_pkey" PRIMARY KEY ("scan_log_id")
);

-- CreateTable
CREATE TABLE "claims" (
    "claim_id" UUID NOT NULL,
    "beneficiary_id" UUID NOT NULL,
    "distribution_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "verified_by" UUID,
    "allocation_id" UUID NOT NULL,
    "claim_status" "ClaimStatus" NOT NULL DEFAULT 'PENDING',
    "verification_method" "VerificationMethod" NOT NULL DEFAULT 'QR',
    "biometric_verified" BOOLEAN NOT NULL DEFAULT false,
    "biometric_score" DECIMAL(5,4),
    "qr_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_duplicate_flag" BOOLEAN NOT NULL DEFAULT false,
    "claimed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("claim_id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "transaction_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "beneficiary_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "transaction_type" VARCHAR(20) NOT NULL,
    "reference_no" VARCHAR(100) NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("transaction_id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "notification_id" UUID NOT NULL,
    "beneficiary_id" UUID NOT NULL,
    "schedule_id" UUID,
    "channel" "NotificationChannel" NOT NULL,
    "message" TEXT NOT NULL,
    "notification_type" VARCHAR(30) NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("notification_id")
);

-- CreateTable
CREATE TABLE "chatbot_sessions" (
    "session_id" UUID NOT NULL,
    "beneficiary_id" UUID,
    "language" VARCHAR(10),
    "is_escalated" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chatbot_sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "chatbot_messages" (
    "message_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "sender_type" "ChatbotSenderType" NOT NULL,
    "message_text" TEXT NOT NULL,
    "intent_detected" VARCHAR(100),
    "confidence_score" DECIMAL(5,4),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chatbot_messages_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "audit_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "entity_affected" VARCHAR(50) NOT NULL,
    "record_id" UUID,
    "ip_address" VARCHAR(64),
    "details" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("audit_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_employee_id_key" ON "users"("employee_id");
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "barangays_barangay_code_key" ON "barangays"("barangay_code");
CREATE UNIQUE INDEX "programs_program_code_key" ON "programs"("program_code");
CREATE UNIQUE INDEX "beneficiaries_email_key" ON "beneficiaries"("email");
CREATE UNIQUE INDEX "beneficiaries_philsys_number_key" ON "beneficiaries"("philsys_number");
CREATE UNIQUE INDEX "enrollments_beneficiary_id_program_id_key" ON "enrollments"("beneficiary_id", "program_id");
CREATE UNIQUE INDEX "biometric_data_beneficiary_id_key" ON "biometric_data"("beneficiary_id");
CREATE UNIQUE INDEX "biometric_data_consent_id_key" ON "biometric_data"("consent_id");
CREATE UNIQUE INDEX "wallet_accounts_beneficiary_id_key" ON "wallet_accounts"("beneficiary_id");
CREATE UNIQUE INDEX "distribution_allocations_distribution_id_beneficiary_id_key" ON "distribution_allocations"("distribution_id", "beneficiary_id");
CREATE UNIQUE INDEX "schedules_distribution_id_beneficiary_id_key" ON "schedules"("distribution_id", "beneficiary_id");
CREATE UNIQUE INDEX "schedules_slot_id_queue_number_key" ON "schedules"("slot_id", "queue_number");
CREATE UNIQUE INDEX "qr_tokens_token_hash_key" ON "qr_tokens"("token_hash");
CREATE UNIQUE INDEX "qr_tokens_beneficiary_id_distribution_id_key" ON "qr_tokens"("beneficiary_id", "distribution_id");
CREATE UNIQUE INDEX "claims_schedule_id_key" ON "claims"("schedule_id");
CREATE UNIQUE INDEX "claims_allocation_id_key" ON "claims"("allocation_id");
CREATE UNIQUE INDEX "claims_beneficiary_id_distribution_id_key" ON "claims"("beneficiary_id", "distribution_id");
CREATE UNIQUE INDEX "transactions_reference_no_key" ON "transactions"("reference_no");
CREATE INDEX "audit_logs_entity_affected_record_id_idx" ON "audit_logs"("entity_affected", "record_id");
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_barangay_id_fkey" FOREIGN KEY ("barangay_id") REFERENCES "barangays"("barangay_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "program_criteria" ADD CONSTRAINT "program_criteria_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("program_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "beneficiaries" ADD CONSTRAINT "beneficiaries_barangay_id_fkey" FOREIGN KEY ("barangay_id") REFERENCES "barangays"("barangay_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("program_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "beneficiary_documents" ADD CONSTRAINT "beneficiary_documents_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "beneficiary_documents" ADD CONSTRAINT "beneficiary_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "biometric_consents" ADD CONSTRAINT "biometric_consents_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "biometric_consents" ADD CONSTRAINT "biometric_consents_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "biometric_data" ADD CONSTRAINT "biometric_data_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "biometric_data" ADD CONSTRAINT "biometric_data_enrolled_by_fkey" FOREIGN KEY ("enrolled_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "biometric_data" ADD CONSTRAINT "biometric_data_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "biometric_consents"("consent_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("program_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "distributions" ADD CONSTRAINT "distributions_barangay_id_fkey" FOREIGN KEY ("barangay_id") REFERENCES "barangays"("barangay_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "distribution_slots" ADD CONSTRAINT "distribution_slots_distribution_id_fkey" FOREIGN KEY ("distribution_id") REFERENCES "distributions"("distribution_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "distribution_allocations" ADD CONSTRAINT "distribution_allocations_distribution_id_fkey" FOREIGN KEY ("distribution_id") REFERENCES "distributions"("distribution_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "distribution_allocations" ADD CONSTRAINT "distribution_allocations_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "distribution_allocations" ADD CONSTRAINT "distribution_allocations_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("enrollment_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "distribution_allocations" ADD CONSTRAINT "distribution_allocations_allocated_by_fkey" FOREIGN KEY ("allocated_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_distribution_id_fkey" FOREIGN KEY ("distribution_id") REFERENCES "distributions"("distribution_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "distribution_slots"("slot_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "qr_tokens" ADD CONSTRAINT "qr_tokens_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "qr_tokens" ADD CONSTRAINT "qr_tokens_distribution_id_fkey" FOREIGN KEY ("distribution_id") REFERENCES "distributions"("distribution_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "qr_scan_logs" ADD CONSTRAINT "qr_scan_logs_qr_token_id_fkey" FOREIGN KEY ("qr_token_id") REFERENCES "qr_tokens"("qr_token_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "qr_scan_logs" ADD CONSTRAINT "qr_scan_logs_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("claim_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "qr_scan_logs" ADD CONSTRAINT "qr_scan_logs_scanned_by_fkey" FOREIGN KEY ("scanned_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "claims" ADD CONSTRAINT "claims_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "claims" ADD CONSTRAINT "claims_distribution_id_fkey" FOREIGN KEY ("distribution_id") REFERENCES "distributions"("distribution_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "claims" ADD CONSTRAINT "claims_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("schedule_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "claims" ADD CONSTRAINT "claims_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "claims" ADD CONSTRAINT "claims_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "distribution_allocations"("allocation_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("claim_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallet_accounts"("wallet_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("schedule_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "chatbot_sessions" ADD CONSTRAINT "chatbot_sessions_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "chatbot_messages" ADD CONSTRAINT "chatbot_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chatbot_sessions"("session_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
