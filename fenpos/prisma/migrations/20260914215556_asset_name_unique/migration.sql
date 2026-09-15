-- DropIndex
DROP INDEX "assets_kind_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "assets_name_key" ON "assets"("name");
