-- CreateTable
CREATE TABLE "audit_events" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_kind" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_name" TEXT,
    "actor_email" TEXT,
    "api_key_id" TEXT,
    "api_key_name" TEXT,
    "action" TEXT NOT NULL,
    "target_kind" TEXT,
    "target_id" TEXT,
    "target_label" TEXT,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "session_id" TEXT,
    "prev_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "audit_anchor" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "seq" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_prev_hash_key" ON "audit_events"("prev_hash");

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_hash_key" ON "audit_events"("hash");

-- CreateIndex
CREATE INDEX "audit_events_at_idx" ON "audit_events"("at");

-- CreateIndex
CREATE INDEX "audit_events_action_at_idx" ON "audit_events"("action", "at");

-- CreateIndex
CREATE INDEX "audit_events_actor_user_id_at_idx" ON "audit_events"("actor_user_id", "at");

-- CreateIndex
CREATE INDEX "audit_events_outcome_at_idx" ON "audit_events"("outcome", "at");
