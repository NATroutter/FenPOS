import "server-only";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";
import { env, isProduction } from "@/lib/env";

/**
 * The application's single Prisma client.
 *
 * Prisma 7 requires an explicit driver adapter; for a local SQLite file that is
 * better-sqlite3. The adapter is constructed here and nowhere else, so there is exactly one
 * connection pool and one place where database configuration is decided.
 *
 * In development the client is cached on `globalThis` because Next.js re-evaluates modules
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

const globalForPrisma = globalThis as unknown as {
	prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (!isProduction) {
	globalForPrisma.prisma = prisma;
}
