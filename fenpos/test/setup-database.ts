import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll } from "vitest";

/**
 * Provides a real, migrated SQLite database for tests that exercise persistence.
 *
 * A real database is used rather than a mocked Prisma client because the behaviour worth
 * testing here lives in the database: unique constraints, cascade deletes, and the exact
 * semantics of an expiry comparison. A mock would assert that the code calls Prisma the way
 * the test author imagined, which is precisely the kind of test that passes while the
 * feature is broken.
 *
 * The file is per-process, so parallel test files cannot interfere with each other, and it
 * is created before any module reads DATABASE_URL — lib/env.ts parses the environment at
 * import time, so this must run as a setup file rather than inside a test.
 */

const SERVER_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DATABASE_FILE = join(SERVER_ROOT, "data", `test-${process.pid}.db`);
const LOGS_DATABASE_FILE = join(SERVER_ROOT, "data", `test-${process.pid}-logs.db`);

process.env.DATABASE_URL = `file:${DATABASE_FILE}`;

// Set rather than derived. lib/env.ts would otherwise place the logs database beside the file
// above, and every worker process shares one data/ directory — so they would all share one logs
// file and evict each other's rows. `prisma-logs.config.ts` reads the same variable, which is what
// keeps the migration below and the client under test addressing the same file.
process.env.LOGS_DATABASE_URL = `file:${LOGS_DATABASE_FILE}`;

// lib/env.ts parses the environment at import time and refuses a missing signing key, so this
// must be set before any module that reaches it is imported — the same reason DATABASE_URL is
// assigned here rather than inside a test. The value is not a secret and does not need to be:
// nothing in the suite verifies a real session cookie.
process.env.BETTER_AUTH_SECRET ??= "test-signing-key-not-a-secret-000000";

beforeAll(() => {
	mkdirSync(join(SERVER_ROOT, "data"), { recursive: true });

	// `migrate deploy` applies the committed migrations rather than diffing the schema, so
	// tests run against exactly the DDL that production will run.
	execFileSync("npx", ["prisma", "migrate", "deploy"], {
		cwd: SERVER_ROOT,
		env: { ...process.env, DATABASE_URL: `file:${DATABASE_FILE}` },
		stdio: "pipe",
		shell: process.platform === "win32",
	});

	// The logs database has its own schema, its own migration history and its own CLI config.
	// `--config` is required rather than `--schema`: with `--schema` the CLI still loads the
	// default prisma.config.ts, and would apply the application's migrations to the application's
	// database while reporting that it had loaded prisma/logs.prisma.
	execFileSync("npx", ["prisma", "migrate", "deploy", "--config", "prisma-logs.config.ts"], {
		cwd: SERVER_ROOT,
		env: { ...process.env, LOGS_DATABASE_URL: `file:${LOGS_DATABASE_FILE}` },
		stdio: "pipe",
		shell: process.platform === "win32",
	});
});

afterAll(async () => {
	// Imported dynamically: a static import would be hoisted above the DATABASE_URL
	// assignment at the top of this file, and lib/env.ts reads the environment on import.
	const { logsDb, prisma } = await import("@/lib/db");

	// Windows keeps the file locked until the pool is closed, so this must precede removal.
	await prisma.$disconnect();
	await logsDb.$disconnect();

	// SQLite writes sidecar files in WAL mode; remove them too so a rerun starts clean.
	for (const file of [DATABASE_FILE, LOGS_DATABASE_FILE]) {
		for (const suffix of ["", "-journal", "-wal", "-shm"]) {
			try {
				rmSync(`${file}${suffix}`, { force: true });
			} catch (error) {
				// A fixture file left behind is harmless: it is gitignored and the next run uses
				// a different name. Failing the suite over it would turn a clean-up detail into a
				// spurious test failure, so report it and move on.
				process.stderr.write(`Could not remove test database ${file}${suffix}: ${String(error)}\n`);
			}
		}
	}
});
