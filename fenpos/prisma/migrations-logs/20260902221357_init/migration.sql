-- CreateTable
CREATE TABLE "log_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "severity" INTEGER NOT NULL DEFAULT 1,
    "message" TEXT NOT NULL,
    "agent_id" TEXT,
    "device_id" TEXT,
    "agent_name" TEXT,
    "device_name" TEXT,
    "api_key_id" TEXT
);

-- CreateIndex
CREATE INDEX "log_entries_ts_idx" ON "log_entries"("ts");

-- CreateIndex
CREATE INDEX "log_entries_severity_ts_idx" ON "log_entries"("severity", "ts");

-- CreateIndex
CREATE INDEX "log_entries_agent_id_ts_idx" ON "log_entries"("agent_id", "ts");

-- CreateIndex
CREATE INDEX "log_entries_api_key_id_ts_idx" ON "log_entries"("api_key_id", "ts");
