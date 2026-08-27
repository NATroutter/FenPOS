/*
  Warnings:

  - You are about to drop the `log_entries` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "log_entries";
PRAGMA foreign_keys=on;
