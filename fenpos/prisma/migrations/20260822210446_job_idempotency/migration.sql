-- AlterTable
ALTER TABLE "jobs" ADD COLUMN "idempotency_hash" TEXT;
ALTER TABLE "jobs" ADD COLUMN "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "jobs_api_key_id_idempotency_key_key" ON "jobs"("api_key_id", "idempotency_key");
