CREATE TABLE "staff_assistant_conversations" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "role" "UserRole" NOT NULL,
  "barangay_id" UUID,
  "title" VARCHAR(90) NOT NULL DEFAULT 'New conversation',
  "language" VARCHAR(3) NOT NULL DEFAULT 'ceb',
  "input" VARCHAR(300) NOT NULL DEFAULT '',
  "unfinished" BOOLEAN NOT NULL DEFAULT false,
  "message_count" INTEGER NOT NULL DEFAULT 0,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "last_mutation_id" UUID,
  "archived_at" TIMESTAMPTZ(6),
  "deleted_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMPTZ(6) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "staff_assistant_conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "staff_assistant_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "staff_assistant_conversations_owner_activity_idx" ON "staff_assistant_conversations"("user_id", "role", "barangay_id", "last_used_at");
CREATE INDEX "staff_assistant_conversations_expires_at_idx" ON "staff_assistant_conversations"("expires_at");
CREATE TABLE "staff_assistant_messages" (
  "conversation_id" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "role" VARCHAR(10) NOT NULL,
  "content" TEXT NOT NULL,
  "local" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "staff_assistant_messages_pkey" PRIMARY KEY ("conversation_id", "position"),
  CONSTRAINT "staff_assistant_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "staff_assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
