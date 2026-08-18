/*
  Warnings:

  - You are about to drop the `nodes` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `node_id` on the `devices` table. All the data in the column will be lost.
  - You are about to drop the column `node_id` on the `jobs` table. All the data in the column will be lost.
  - You are about to drop the column `node_id` on the `log_entries` table. All the data in the column will be lost.
  - You are about to drop the column `node_id` on the `pairing_codes` table. All the data in the column will be lost.
  - Added the required column `agent_id` to the `devices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `agent_id` to the `jobs` table without a default value. This is not possible if the table is not empty.
  - Added the required column `agent_id` to the `pairing_codes` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "nodes_status_idx";

-- DropIndex
DROP INDEX "nodes_token_hash_key";

-- DropIndex
DROP INDEX "nodes_name_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "nodes";
PRAGMA foreign_keys=on;

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

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_devices" (
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
INSERT INTO "new_devices" ("auto_connect", "auto_reconnect", "baud_rate", "codepage", "columns", "created_at", "data_bits", "default_linefeed", "default_wrap", "flow_control", "id", "max_body_bytes", "max_line_chars", "max_lines", "max_output_lines", "max_queue_depth", "max_total_chars", "name", "on_unsupported", "parity", "paused", "port", "reconnect_delay_seconds", "stop_bits", "updated_at", "write_timeout_ms") SELECT "auto_connect", "auto_reconnect", "baud_rate", "codepage", "columns", "created_at", "data_bits", "default_linefeed", "default_wrap", "flow_control", "id", "max_body_bytes", "max_line_chars", "max_lines", "max_output_lines", "max_queue_depth", "max_total_chars", "name", "on_unsupported", "parity", "paused", "port", "reconnect_delay_seconds", "stop_bits", "updated_at", "write_timeout_ms" FROM "devices";
DROP TABLE "devices";
ALTER TABLE "new_devices" RENAME TO "devices";
CREATE INDEX "devices_agent_id_idx" ON "devices"("agent_id");
CREATE UNIQUE INDEX "devices_agent_id_name_key" ON "devices"("agent_id", "name");
CREATE TABLE "new_jobs" (
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
    CONSTRAINT "jobs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "jobs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "jobs_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_jobs" ("api_key_id", "bytes", "device_id", "error_code", "error_message", "finished_at", "id", "lines", "queued_at", "started_at", "status", "submitted_at") SELECT "api_key_id", "bytes", "device_id", "error_code", "error_message", "finished_at", "id", "lines", "queued_at", "started_at", "status", "submitted_at" FROM "jobs";
DROP TABLE "jobs";
ALTER TABLE "new_jobs" RENAME TO "jobs";
CREATE INDEX "jobs_status_idx" ON "jobs"("status");
CREATE INDEX "jobs_submitted_at_idx" ON "jobs"("submitted_at");
CREATE INDEX "jobs_device_id_submitted_at_idx" ON "jobs"("device_id", "submitted_at");
CREATE INDEX "jobs_agent_id_submitted_at_idx" ON "jobs"("agent_id", "submitted_at");
CREATE TABLE "new_log_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "agent_id" TEXT,
    "device_id" TEXT,
    CONSTRAINT "log_entries_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "log_entries_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_log_entries" ("device_id", "id", "level", "message", "ts") SELECT "device_id", "id", "level", "message", "ts" FROM "log_entries";
DROP TABLE "log_entries";
ALTER TABLE "new_log_entries" RENAME TO "log_entries";
CREATE INDEX "log_entries_ts_idx" ON "log_entries"("ts");
CREATE INDEX "log_entries_level_ts_idx" ON "log_entries"("level", "ts");
CREATE INDEX "log_entries_agent_id_ts_idx" ON "log_entries"("agent_id", "ts");
CREATE TABLE "new_pairing_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agent_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "consumed_at" DATETIME,
    CONSTRAINT "pairing_codes_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_pairing_codes" ("code", "consumed_at", "created_at", "expires_at", "id") SELECT "code", "consumed_at", "created_at", "expires_at", "id" FROM "pairing_codes";
DROP TABLE "pairing_codes";
ALTER TABLE "new_pairing_codes" RENAME TO "pairing_codes";
CREATE UNIQUE INDEX "pairing_codes_code_key" ON "pairing_codes"("code");
CREATE INDEX "pairing_codes_agent_id_idx" ON "pairing_codes"("agent_id");
CREATE INDEX "pairing_codes_expires_at_idx" ON "pairing_codes"("expires_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "agents_name_key" ON "agents"("name");

-- CreateIndex
CREATE UNIQUE INDEX "agents_token_hash_key" ON "agents"("token_hash");

-- CreateIndex
CREATE INDEX "agents_status_idx" ON "agents"("status");
