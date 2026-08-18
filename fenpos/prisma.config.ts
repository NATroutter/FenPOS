import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration.
 *
 * The datasource URL lives here rather than in schema.prisma because Prisma 7 moved
 * connection configuration out of the schema. Keeping it in one place means the runtime
 * client and the migration CLI cannot disagree about which database they are addressing.
 */
export default defineConfig({
	schema: "prisma/schema.prisma",
	migrations: {
		path: "prisma/migrations",
	},
	datasource: {
		url: process.env.DATABASE_URL,
	},
});
