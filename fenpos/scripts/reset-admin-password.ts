import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client";
import { ADMIN_ROW_ID } from "../lib/auth/admin-credential";

/**
 * Returns the install to its unconfigured state, so the next start generates a fresh
 * administrator password and prints it.
 *
 * Exists for testing the first-run experience, which is otherwise a one-shot: once a password
 * has been set there is no way back to the generated-password path short of deleting the
 * database, which takes the agents, devices, keys and job history with it.
 *
 * Usage:
 *   pnpm admin:reset-password
 *   pnpm dev
 *
 * Deletes only the credential and the sessions it authorised. Everything else the install
 * knows is left alone, which is the point — resetting the password to re-test the sign-in
 * flow should not cost a paired agent.
 *
 * Safe to run on a live install, in that nothing is unrecoverable: the next start prints a new
 * password. It is still disruptive, since every session ends and nobody can sign in until
 * someone reads the log.
 *
 * The row id is shared with the application rather than repeated here, for the same reason
 * set-admin-password.ts shares its hashing and validation.
 */

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
	}

	const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: databaseUrl }) });

	try {
		// Sessions first. Removing the credential while a session survived would leave someone
		// signed in to an install that no longer has an administrator.
		const { count: sessions } = await prisma.session.deleteMany({});
		const { count: credentials } = await prisma.adminAuth.deleteMany({ where: { id: ADMIN_ROW_ID } });

		if (credentials === 0) {
			process.stdout.write("No administrator was configured. The next start will generate a password.\n");
		} else {
			process.stdout.write(`Administrator credential removed. Sessions ended: ${sessions}\n`);
		}
		process.stdout.write("Restart the server; the new password is printed to its log.\n");
	} finally {
		await prisma.$disconnect();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
