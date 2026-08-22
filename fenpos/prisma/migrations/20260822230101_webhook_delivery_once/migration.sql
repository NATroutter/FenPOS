-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_webhook_id_job_id_key" ON "webhook_deliveries"("webhook_id", "job_id");
