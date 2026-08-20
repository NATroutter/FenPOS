-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_log_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "severity" INTEGER NOT NULL DEFAULT 1,
    "message" TEXT NOT NULL,
    "agent_id" TEXT,
    "device_id" TEXT,
    CONSTRAINT "log_entries_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "log_entries_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
-- Backfilled from the level rather than left at the column default. Prisma copies the old columns
-- and lets the default fill the new one, which would silently record every historical line as INFO
-- and make the Level ordering and the severity filter disagree with the level shown beside them.
INSERT INTO "new_log_entries" ("agent_id", "device_id", "id", "level", "severity", "message", "ts")
SELECT "agent_id", "device_id", "id", "level",
       CASE "level" WHEN 'DEBUG' THEN 0 WHEN 'INFO' THEN 1 WHEN 'WARN' THEN 2 WHEN 'ERROR' THEN 3 ELSE 1 END,
       "message", "ts"
FROM "log_entries";
DROP TABLE "log_entries";
ALTER TABLE "new_log_entries" RENAME TO "log_entries";
CREATE INDEX "log_entries_ts_idx" ON "log_entries"("ts");
CREATE INDEX "log_entries_severity_ts_idx" ON "log_entries"("severity", "ts");
CREATE INDEX "log_entries_agent_id_ts_idx" ON "log_entries"("agent_id", "ts");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
