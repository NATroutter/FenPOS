-- CreateTable
CREATE TABLE "metric_job_hourly" (
    "bucket" DATETIME NOT NULL,
    "device_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "device_name" TEXT NOT NULL,
    "agent_name" TEXT NOT NULL,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "cancelled" INTEGER NOT NULL DEFAULT 0,
    "panel_jobs" INTEGER NOT NULL DEFAULT 0,
    "api_jobs" INTEGER NOT NULL DEFAULT 0,
    "bytes_total" INTEGER NOT NULL DEFAULT 0,
    "lines_total" INTEGER NOT NULL DEFAULT 0,
    "queue_hist" TEXT NOT NULL DEFAULT '[]',
    "print_hist" TEXT NOT NULL DEFAULT '[]',
    "total_hist" TEXT NOT NULL DEFAULT '[]',
    "queue_sum_ms" INTEGER NOT NULL DEFAULT 0,
    "queue_count" INTEGER NOT NULL DEFAULT 0,
    "queue_min_ms" INTEGER,
    "queue_max_ms" INTEGER,
    "print_sum_ms" INTEGER NOT NULL DEFAULT 0,
    "print_count" INTEGER NOT NULL DEFAULT 0,
    "print_min_ms" INTEGER,
    "print_max_ms" INTEGER,
    "total_sum_ms" INTEGER NOT NULL DEFAULT 0,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "total_min_ms" INTEGER,
    "total_max_ms" INTEGER,
    "clock_skew_count" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("bucket", "device_id")
);

-- CreateTable
CREATE TABLE "metric_error_hourly" (
    "bucket" DATETIME NOT NULL,
    "device_id" TEXT NOT NULL,
    "error_code" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "device_name" TEXT NOT NULL,
    "agent_name" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("bucket", "device_id", "error_code")
);

-- CreateTable
CREATE TABLE "metric_api_hourly" (
    "bucket" DATETIME NOT NULL,
    "route" TEXT NOT NULL,
    "status_class" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "duration_sum_ms" INTEGER NOT NULL DEFAULT 0,
    "duration_hist" TEXT NOT NULL DEFAULT '[]',

    PRIMARY KEY ("bucket", "route", "status_class", "api_key_id")
);

-- CreateTable
CREATE TABLE "metric_auth_hourly" (
    "bucket" DATETIME NOT NULL,
    "kind" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("bucket", "kind")
);

-- CreateTable
CREATE TABLE "metric_webhook_hourly" (
    "bucket" DATETIME NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "webhook_name" TEXT NOT NULL,
    "queued" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "attempts_sum" INTEGER NOT NULL DEFAULT 0,
    "attempts_max" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("bucket", "webhook_id")
);

-- CreateTable
CREATE TABLE "fleet_samples" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL,
    "agents_total" INTEGER NOT NULL,
    "agents_online" INTEGER NOT NULL,
    "devices_total" INTEGER NOT NULL,
    "devices_connected" INTEGER NOT NULL,
    "queue_depth" INTEGER NOT NULL,
    "pending_webhooks" INTEGER NOT NULL,
    "active_sessions" INTEGER NOT NULL,
    "db_main_bytes" INTEGER NOT NULL,
    "db_audit_bytes" INTEGER NOT NULL,
    "db_logs_bytes" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "metric_watermarks" (
    "stream" TEXT NOT NULL PRIMARY KEY,
    "rolled_through" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "metric_job_hourly_bucket_idx" ON "metric_job_hourly"("bucket");

-- CreateIndex
CREATE INDEX "metric_job_hourly_agent_id_bucket_idx" ON "metric_job_hourly"("agent_id", "bucket");

-- CreateIndex
CREATE INDEX "metric_error_hourly_bucket_idx" ON "metric_error_hourly"("bucket");

-- CreateIndex
CREATE INDEX "metric_api_hourly_bucket_idx" ON "metric_api_hourly"("bucket");

-- CreateIndex
CREATE INDEX "metric_auth_hourly_bucket_idx" ON "metric_auth_hourly"("bucket");

-- CreateIndex
CREATE INDEX "metric_webhook_hourly_bucket_idx" ON "metric_webhook_hourly"("bucket");

-- CreateIndex
CREATE INDEX "fleet_samples_at_idx" ON "fleet_samples"("at");
