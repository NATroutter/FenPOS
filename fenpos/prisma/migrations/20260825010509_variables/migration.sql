-- CreateTable
CREATE TABLE "variables" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT,
    "pattern" TEXT,
    "offset_amount" INTEGER,
    "offset_unit" TEXT,
    "source" TEXT,
    "overridable" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "device_variables" (
    "device_id" TEXT NOT NULL,
    "variable_id" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    PRIMARY KEY ("device_id", "variable_id"),
    CONSTRAINT "device_variables_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "device_variables_variable_id_fkey" FOREIGN KEY ("variable_id") REFERENCES "variables" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "variables_name_key" ON "variables"("name");

-- CreateIndex
CREATE INDEX "device_variables_variable_id_idx" ON "device_variables"("variable_id");
