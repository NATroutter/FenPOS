import "server-only";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaClient as AuditPrismaClient } from "@/generated/prisma-audit/client";
import { PrismaClient as LogsPrismaClient } from "@/generated/prisma-logs/client";
import { PrismaClient as MetricsPrismaClient } from "@/generated/prisma-metrics/client";
import { AUDIT_DATABASE_URL, env, isProduction, LOGS_DATABASE_URL, METRICS_DATABASE_URL } from "@/lib/env";

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

/**
 * Builds a client bound to the audit database file.
 *
 * @returns a client ready for queries against `audit_events` and `audit_anchor`
 */
function createAuditClient(): AuditPrismaClient {
	const adapter = new PrismaBetterSqlite3({ url: AUDIT_DATABASE_URL });

	return new AuditPrismaClient({
		adapter,
		// Off for the same reason as above, and more so: a statement here carries the actor, the
		// address they came from and whatever `detail` the action recorded.
		log: ["warn", "error"],
	});
}

/**
 * Builds a client bound to the metrics database file.
 *
 * @returns a client ready for queries against the rollup and fleet-sample tables
 */
function createMetricsClient(): MetricsPrismaClient {
	const adapter = new PrismaBetterSqlite3({ url: METRICS_DATABASE_URL });

	return new MetricsPrismaClient({
		adapter,
		// Off for the same reason as above: everything here is derived data, but a statement can
		// still carry a device or agent name.
		log: ["warn", "error"],
	});
}

const globalForPrisma = globalThis as unknown as {
	prisma: PrismaClient | undefined;
	logsDb: LogsPrismaClient | undefined;
	auditDb: AuditPrismaClient | undefined;
	metricsDb: MetricsPrismaClient | undefined;
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

/**
 * The audit database's client.
 *
 * Separate from {@link prisma} and {@link logsDb} because the audit record is the one thing here
 * that has to survive everything else: its own file means its retention is decided by its own
 * settings rather than by however many log lines or jobs an install happened to produce.
 *
 * Two things it deliberately does not buy. It does not make the record tamper-proof — that is the
 * hash chain's job, and this file is as writable as the last one was. And it does not make the
 * panel's auditing independent of the application database: the retention sweep reads its bounds
 * through {@link prisma} (`globalAuditSettings`), and a caller like `require-permission.ts` reads a
 * setting through {@link prisma} to decide whether to record a page view at all. What it buys is
 * that nothing else's volume can decide how far back the record goes.
 *
 * It is a different generated client, not the same one pointed elsewhere, so `auditDb.auditEvent`
 * and `prisma.user` cannot be written into one query. The two databases cannot be joined, and the
 * typechecker is what enforces it — which is also why a deleted user still has a trail: there was
 * never a foreign key that could have taken it away.
 */
export const auditDb: AuditPrismaClient = globalForPrisma.auditDb ?? createAuditClient();

/**
 * The metrics database's client.
 *
 * Separate from {@link prisma}, {@link logsDb} and {@link auditDb} for the same reason those are
 * split out: everything in this file is a rollup or a fleet sample, derived data that can be
 * deleted and rebuilt, and its own file means that rebuild — or its own retention — never competes
 * with the application, log, or audit databases for space.
 *
 * It is a different generated client, not the same one pointed elsewhere, so `metricsDb.fleetSample`
 * and `prisma.agent` cannot be written into one query. The two databases cannot be joined, and the
 * typechecker is what enforces it.
 */
export const metricsDb: MetricsPrismaClient = globalForPrisma.metricsDb ?? createMetricsClient();

if (!isProduction) {
	globalForPrisma.prisma = prisma;
	globalForPrisma.logsDb = logsDb;
	globalForPrisma.auditDb = auditDb;
	globalForPrisma.metricsDb = metricsDb;
}
