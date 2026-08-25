import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client";
import { describeVerification, verifyAuditChain } from "../lib/audit/verify";

/**
 * Proves the audit record has not been edited.
 *
 * Usage:
 *   pnpm audit:verify
 *
 * Exits 0 when the chain is whole and 1 when it is not, so it can be run from a cron entry or a
 * monitoring check without anyone reading the output.
 *
 * **It cannot repair anything, and there is no flag that would.** A broken chain is evidence: the
 * `seq` it names is where somebody changed the record, and the rows on either side of it are what
 * an investigation starts from. A command that offered to fix it would be a command that offered to
 * finish the job for whoever broke it.
 *
 * Available from a shell rather than only from the panel because the panel is exactly what an
 * attacker holding superuser credentials already has. This needs filesystem access, which grants
 * nothing to anyone who could not already read the database directly.
 *
 * Builds its own client rather than reaching for `lib/db.ts`, which begins with
 * `import "server-only"` and throws outside Next — the same reason `scripts/seed-demo-data.ts`
 * builds one. `dotenv/config` is what puts `DATABASE_URL` in the environment out here.
 *
 * The reporting lives in `lib/audit/verify.ts` rather than here, so it can be tested without a test
 * importing this file and running `main()` as a side effect of the import.
 */
async function main(): Promise<void> {
	const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? "" }) });

	try {
		const result = await verifyAuditChain(prisma);
		process.stdout.write(`${describeVerification(result)}\n`);
		process.exitCode = result.ok ? 0 : 1;
	} finally {
		await prisma.$disconnect();
	}
}

void main();
