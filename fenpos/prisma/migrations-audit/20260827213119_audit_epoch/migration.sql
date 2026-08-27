-- CreateTable
CREATE TABLE "audit_epoch" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "seq" INTEGER NOT NULL,
    "prev_hash" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL
);
