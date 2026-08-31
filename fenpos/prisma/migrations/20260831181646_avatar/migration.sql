-- CreateTable
CREATE TABLE "avatars" (
    "user_id" TEXT NOT NULL PRIMARY KEY,
    "original" BLOB NOT NULL,
    "original_mime_type" TEXT NOT NULL,
    "crop_x" INTEGER NOT NULL,
    "crop_y" INTEGER NOT NULL,
    "crop_size" INTEGER NOT NULL,
    "baked" BLOB NOT NULL,
    "baked_mime_type" TEXT NOT NULL,
    "baked_size" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "avatars_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
