/*
  Warnings:

  - You are about to drop the column `code_hash` on the `pairing_codes` table. All the data in the column will be lost.
  - You are about to drop the column `code_plain` on the `pairing_codes` table. All the data in the column will be lost.
  - Added the required column `code` to the `pairing_codes` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_pairing_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "node_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "consumed_at" DATETIME,
    CONSTRAINT "pairing_codes_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_pairing_codes" ("consumed_at", "created_at", "expires_at", "id", "node_id") SELECT "consumed_at", "created_at", "expires_at", "id", "node_id" FROM "pairing_codes";
DROP TABLE "pairing_codes";
ALTER TABLE "new_pairing_codes" RENAME TO "pairing_codes";
CREATE UNIQUE INDEX "pairing_codes_code_key" ON "pairing_codes"("code");
CREATE INDEX "pairing_codes_node_id_idx" ON "pairing_codes"("node_id");
CREATE INDEX "pairing_codes_expires_at_idx" ON "pairing_codes"("expires_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
