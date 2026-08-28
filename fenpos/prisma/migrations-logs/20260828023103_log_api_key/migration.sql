-- AlterTable
ALTER TABLE "log_entries" ADD COLUMN "api_key_id" TEXT;

-- CreateIndex
CREATE INDEX "log_entries_api_key_id_ts_idx" ON "log_entries"("api_key_id", "ts");
