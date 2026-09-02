import "dotenv/config";
import { defineConfig } from "prisma/config";
import { siblingDatabaseUrl } from "./lib/database-url";

/**
 * Prisma CLI configuration for the metrics database. The same shape as prisma-logs.config.ts and
 * for the same reasons — see that file. `METRICS_DATABASE_URL` overrides the derivation, which is
 * how the test harness gives each worker its own file.
 */
const applicationDatabaseUrl = process.env.DATABASE_URL;

export default defineConfig({
	schema: "prisma/metrics.prisma",
	migrations: {
		path: "prisma/migrations-metrics",
	},
	datasource: {
		url:
			process.env.METRICS_DATABASE_URL ??
			(applicationDatabaseUrl ? siblingDatabaseUrl(applicationDatabaseUrl, "metrics.db") : undefined),
	},
});
