-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_admin_auth" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "password_hash" TEXT NOT NULL,
    "is_generated" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_admin_auth" ("id", "password_hash", "updated_at") SELECT "id", "password_hash", "updated_at" FROM "admin_auth";
DROP TABLE "admin_auth";
ALTER TABLE "new_admin_auth" RENAME TO "admin_auth";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
