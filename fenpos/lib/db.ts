import "server-only";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaClient as LogsPrismaClient } from "@/generated/prisma-logs/client";
import { env, isProduction, LOGS_DATABASE_URL } from "@/lib/env";

/**
 * The application's Prisma clients, one per database file.
 *
 * Prisma 7 requires an explicit driver adapter; for a local SQLite file that is
 * better-sqlite3. The adapters are constructed here and nowhere else, so there is exactly one
 * connection pool per database and one place where database configuration is decided.
 *
 * In development each client is cached on `globalThis` because Next.js re-evaluates modules
 * on every hot reload. Without the cache each reload would open another SQLite handle and
 * the process would eventually exhaust its file descriptors while holding stale locks.
 */

/**
 * Builds a client bound to the configured database file.
 *
 * @returns a client ready for queries; callers do not need to connect explicitly
 */
function createPrismaClient(): PrismaClient {
	const adapter = new PrismaBetterSqlite3({ url: env.DATABASE_URL });

	return new PrismaClient({
		adapter,
		// Query logging is deliberately off in every environment: statements carry job and
		// device metadata, and a log file is a weaker place to keep it than the database.
		log: ["warn", "error"],
	});
}

/**
 * Builds a client bound to the logs database file.
 *
 * @returns a client ready for queries against `log_entries`
 */
function createLogsClient(): LogsPrismaClient {
	const adapter = new PrismaBetterSqlite3({ url: LOGS_DATABASE_URL });

	return new LogsPrismaClient({
		adapter,
		// Off for the same reason as above: a statement here carries the log message itself,
		// along with whichever agent and device it names.
		log: ["warn", "error"],
	});
}

const globalForPrisma = globalThis as unknown as {
	prisma: PrismaClient | undefined;
	logsDb: LogsPrismaClient | undefined;
};

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

/**
 * The logs database's client.
 *
 * Separate from {@link prisma} so log volume cannot evict audit history and neither can bloat the
 * application database — the files have separate retention budgets, which is the whole point of
 * the split. It does not make logging survive an unusable application database: both writers read
 * their `logs.*` settings through {@link prisma} first, so that outage still stops a line being
 * recorded. What it buys is that a flood of lines cannot cost anything else its history.
 *
 * It is a different generated client, not the same one pointed elsewhere, so `logsDb.logEntry` and
 * `prisma.agent` cannot be written into one query. The two databases cannot be joined, and the
 * typechecker is what enforces it.
 */
export const logsDb: LogsPrismaClient = globalForPrisma.logsDb ?? createLogsClient();

if (!isProduction) {
	globalForPrisma.prisma = prisma;
	globalForPrisma.logsDb = logsDb;
}
