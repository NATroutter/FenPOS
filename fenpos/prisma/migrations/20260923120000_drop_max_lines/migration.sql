-- The cap on lines of `data` is gone: how a receipt is broken into source lines says nothing about
-- what it costs to print, so joining lines slipped the same content past it unchanged.

-- AlterTable
ALTER TABLE "devices" DROP COLUMN "max_lines";

-- The stored install-wide value, which no longer names a setting.
DELETE FROM "settings" WHERE "key" = 'limits.maxLines';
