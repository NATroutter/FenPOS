import "dotenv/config";
import { defineConfig } from "prisma/config";
import { siblingDatabaseUrl } from "./lib/database-url";

/**
 * Prisma CLI configuration for the audit database.
 *
 * A third config rather than a third datasource block: Prisma has no multi-datasource schema, so
 * each database needs its own schema, its own generated client and its own migration history.
 *
 * The URL is derived from `DATABASE_URL` so an install configures one path, not three. It is
 * derived here rather than imported from `lib/env.ts` because that module carries `server-only`
 * and parses the whole environment, neither of which survives being loaded by the CLI; the shared
 * rule lives in `lib/database-url.ts` so the CLI and the server cannot disagree about the path.
 *
 * `AUDIT_DATABASE_URL` overrides the derivation, which is how the test harness gives each worker
 * process its own file — see `test/setup-database.ts`.
 */
const applicationDatabaseUrl = process.env.DATABASE_URL;

export default defineConfig({
	schema: "prisma/audit.prisma",
	migrations: {
		path: "prisma/migrations-audit",
	},
	datasource: {
		url:
			process.env.AUDIT_DATABASE_URL ??
			(applicationDatabaseUrl ? siblingDatabaseUrl(applicationDatabaseUrl, "audit.db") : undefined),
	},
});
