-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "twoFactorEnabled" BOOLEAN DEFAULT false,
    "role" TEXT,
    "banned" BOOLEAN DEFAULT false,
    "banReason" TEXT,
    "banExpires" DATETIME,
    "isSuperuser" BOOLEAN NOT NULL DEFAULT false,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "password_changed_at" DATETIME,
    "failed_sign_in_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" DATETIME
);

-- CreateTable
CREATE TABLE "avatars" (
    "user_id" TEXT NOT NULL PRIMARY KEY,
    "original" BLOB NOT NULL,
    "original_mime_type" TEXT NOT NULL,
    "crop_x" INTEGER NOT NULL,
    "crop_y" INTEGER NOT NULL,
    "crop_size" INTEGER NOT NULL,
    "baked" BLOB NOT NULL,
    "baked_mime_type" TEXT NOT NULL,
    "baked_size" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "avatars_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "password_history" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "password_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" DATETIME NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "impersonatedBy" TEXT,
    "lastSeenAt" DATETIME,
    CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issuer" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" DATETIME,
    "refreshTokenExpiresAt" DATETIME,
    "scope" TEXT,
    "password" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "twoFactor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verified" BOOLEAN DEFAULT true,
    "failedVerificationCount" INTEGER DEFAULT 0,
    "lockedUntil" DATETIME,
    CONSTRAINT "twoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "setup_key" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "key_hash" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" TEXT NOT NULL,
    "permission" TEXT NOT NULL,

    PRIMARY KEY ("role_id", "permission"),
    CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    PRIMARY KEY ("user_id", "role_id"),
    CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user_permissions" (
    "user_id" TEXT NOT NULL,
    "permission" TEXT NOT NULL,

    PRIMARY KEY ("user_id", "permission"),
    CONSTRAINT "user_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "token_hash" TEXT,
    "last_seen_at" DATETIME,
    "agent_version" TEXT,
    "platform" TEXT,
    "hostname" TEXT,
    "last_address" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "pairing_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agent_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "consumed_at" DATETIME,
    CONSTRAINT "pairing_codes_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agent_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "port" TEXT NOT NULL,
    "baud_rate" INTEGER NOT NULL DEFAULT 9600,
    "data_bits" INTEGER NOT NULL DEFAULT 8,
    "stop_bits" INTEGER NOT NULL DEFAULT 1,
    "parity" TEXT NOT NULL DEFAULT 'NONE',
    "flow_control" TEXT NOT NULL DEFAULT 'NONE',
    "write_timeout_ms" INTEGER NOT NULL DEFAULT 5000,
    "auto_connect" BOOLEAN NOT NULL DEFAULT true,
    "auto_reconnect" BOOLEAN NOT NULL DEFAULT true,
    "reconnect_delay_seconds" INTEGER NOT NULL DEFAULT 5,
    "columns" INTEGER NOT NULL DEFAULT 42,
    "codepage" TEXT NOT NULL DEFAULT 'CP858',
    "on_unsupported" TEXT NOT NULL DEFAULT 'REJECT',
    "default_wrap" BOOLEAN NOT NULL DEFAULT true,
    "default_linefeed" TEXT NOT NULL DEFAULT 'LF',
    "max_body_bytes" INTEGER,
    "max_lines" INTEGER,
    "max_line_chars" INTEGER,
    "max_total_chars" INTEGER,
    "max_output_lines" INTEGER,
    "max_queue_depth" INTEGER,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "devices_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "masked_hint" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" DATETIME,
    "revoked_at" DATETIME,
    "created_by_user_id" TEXT,
    "created_by_name" TEXT
);

-- CreateTable
CREATE TABLE "api_key_permissions" (
    "api_key_id" TEXT NOT NULL,
    "permission" TEXT NOT NULL,

    PRIMARY KEY ("api_key_id", "permission"),
    CONSTRAINT "api_key_permissions_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "api_key_devices" (
    "api_key_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,

    PRIMARY KEY ("api_key_id", "device_id"),
    CONSTRAINT "api_key_devices_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "api_key_devices_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agent_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "api_key_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "submitted_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queued_at" DATETIME,
    "started_at" DATETIME,
    "finished_at" DATETIME,
    "lines" INTEGER,
    "bytes" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "idempotency_key" TEXT,
    "idempotency_hash" TEXT,
    CONSTRAINT "jobs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "jobs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "jobs_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL DEFAULT 'IMAGE',
    "name" TEXT NOT NULL,
    "data" BLOB NOT NULL,
    "mime_type" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "source_url" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "variables" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT,
    "pattern" TEXT,
    "offset_amount" INTEGER,
    "offset_unit" TEXT,
    "source" TEXT,
    "overridable" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "device_variables" (
    "device_id" TEXT NOT NULL,
    "variable_id" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    PRIMARY KEY ("device_id", "variable_id"),
    CONSTRAINT "device_variables_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "device_variables_variable_id_fkey" FOREIGN KEY ("variable_id") REFERENCES "variables" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "api_key_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "webhooks_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "webhook_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "delivered_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhooks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "password_history_user_id_created_at_idx" ON "password_history"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "account_issuer_accountId_key" ON "account"("issuer", "accountId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "twoFactor_secret_idx" ON "twoFactor"("secret");

-- CreateIndex
CREATE INDEX "twoFactor_userId_idx" ON "twoFactor"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE INDEX "role_permissions_permission_idx" ON "role_permissions"("permission");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE INDEX "user_permissions_permission_idx" ON "user_permissions"("permission");

-- CreateIndex
CREATE UNIQUE INDEX "agents_name_key" ON "agents"("name");

-- CreateIndex
CREATE UNIQUE INDEX "agents_token_hash_key" ON "agents"("token_hash");

-- CreateIndex
CREATE INDEX "agents_status_idx" ON "agents"("status");

-- CreateIndex
CREATE UNIQUE INDEX "pairing_codes_code_key" ON "pairing_codes"("code");

-- CreateIndex
CREATE INDEX "pairing_codes_agent_id_idx" ON "pairing_codes"("agent_id");

-- CreateIndex
CREATE INDEX "pairing_codes_expires_at_idx" ON "pairing_codes"("expires_at");

-- CreateIndex
CREATE INDEX "devices_agent_id_idx" ON "devices"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_agent_id_name_key" ON "devices"("agent_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_revoked_at_idx" ON "api_keys"("revoked_at");

-- CreateIndex
CREATE INDEX "api_key_devices_device_id_idx" ON "api_key_devices"("device_id");

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "jobs_submitted_at_idx" ON "jobs"("submitted_at");

-- CreateIndex
CREATE INDEX "jobs_device_id_submitted_at_idx" ON "jobs"("device_id", "submitted_at");

-- CreateIndex
CREATE INDEX "jobs_agent_id_submitted_at_idx" ON "jobs"("agent_id", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_api_key_id_idempotency_key_key" ON "jobs"("api_key_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "assets_kind_name_key" ON "assets"("kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "variables_name_key" ON "variables"("name");

-- CreateIndex
CREATE INDEX "device_variables_variable_id_idx" ON "device_variables"("variable_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhooks_api_key_id_key" ON "webhooks"("api_key_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_webhook_id_idx" ON "webhook_deliveries"("webhook_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_webhook_id_job_id_key" ON "webhook_deliveries"("webhook_id", "job_id");
