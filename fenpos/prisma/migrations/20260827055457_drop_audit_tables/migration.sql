/*
  Warnings:

  - You are about to drop the `audit_anchor` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `audit_events` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "audit_anchor";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "audit_events";
PRAGMA foreign_keys=on;
