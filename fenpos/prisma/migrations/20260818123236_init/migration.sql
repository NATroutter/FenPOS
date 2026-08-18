-- CreateTable
CREATE TABLE "admin_auth" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "password_hash" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token_hash" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "last_seen_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" TEXT,
    "ip_address" TEXT
);

-- CreateTable
CREATE TABLE "nodes" (
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
    "node_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "code_plain" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "consumed_at" DATETIME,
    CONSTRAINT "pairing_codes_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "node_id" TEXT NOT NULL,
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
    CONSTRAINT "devices_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "masked_hint" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" DATETIME,
    "revoked_at" DATETIME
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
    "node_id" TEXT NOT NULL,
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
    CONSTRAINT "jobs_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "jobs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "jobs_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "log_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "node_id" TEXT,
    "device_id" TEXT,
    CONSTRAINT "log_entries_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "log_entries_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "nodes_name_key" ON "nodes"("name");

-- CreateIndex
CREATE UNIQUE INDEX "nodes_token_hash_key" ON "nodes"("token_hash");

-- CreateIndex
CREATE INDEX "nodes_status_idx" ON "nodes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "pairing_codes_code_hash_key" ON "pairing_codes"("code_hash");

-- CreateIndex
CREATE INDEX "pairing_codes_node_id_idx" ON "pairing_codes"("node_id");

-- CreateIndex
CREATE INDEX "pairing_codes_expires_at_idx" ON "pairing_codes"("expires_at");

-- CreateIndex
CREATE INDEX "devices_node_id_idx" ON "devices"("node_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_node_id_name_key" ON "devices"("node_id", "name");

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
CREATE INDEX "jobs_node_id_submitted_at_idx" ON "jobs"("node_id", "submitted_at");

-- CreateIndex
CREATE INDEX "log_entries_ts_idx" ON "log_entries"("ts");

-- CreateIndex
CREATE INDEX "log_entries_level_ts_idx" ON "log_entries"("level", "ts");

-- CreateIndex
CREATE INDEX "log_entries_node_id_ts_idx" ON "log_entries"("node_id", "ts");
