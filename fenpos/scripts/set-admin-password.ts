import "dotenv/config";
import { hash } from "@node-rs/argon2";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client";

/**
 * Sets the administrator password from the command line.
 *
 * This is how an install is bootstrapped and how a forgotten password is recovered. Both
 * deliberately require shell access to the server: an unauthenticated web route that can set
 * the first password is a takeover waiting to happen on a server reachable before anyone
 * configures it.
 *
 * Usage:
 *   pnpm admin:set-password "correct horse battery staple"
 *
 * The password is read from argv rather than prompted for, so the command works unattended
 * in a container. That does place it in shell history — acceptable for a bootstrap step run
 * once, and the reason the panel offers a password change of its own for routine rotation.
 *
 * This script deliberately does not import lib/auth/*: those modules are marked
 * `server-only`, which is a Next.js bundler constraint that a plain Agent process cannot
 * satisfy. The argon2 parameters below must therefore stay in step with
 * lib/auth/password.ts, which the accompanying test enforces.
 */

/** Must match ARGON2ID in lib/auth/password.ts. */
const ARGON2ID = 2;

/** Must match ARGON2_OPTIONS in lib/auth/password.ts. */
const ARGON2_OPTIONS = {
	algorithm: ARGON2ID,
	memoryCost: 19_456,
	timeCost: 2,
	parallelism: 1,
} as const;

/** Must match MINIMUM_PASSWORD_LENGTH in lib/auth/password.ts. */
const MINIMUM_PASSWORD_LENGTH = 12;

/** Fixed primary key of the singleton admin row. */
const ADMIN_ROW_ID = 1;

async function main(): Promise<void> {
	const password = process.argv[2];

	if (!password) {
		throw new Error('Usage: pnpm admin:set-password "<password>"');
	}
	if (password.length < MINIMUM_PASSWORD_LENGTH) {
		throw new Error(`Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
	}

	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
	}

	const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: databaseUrl }) });

	try {
		const passwordHash = await hash(password, ARGON2_OPTIONS);

		await prisma.adminAuth.upsert({
			where: { id: ADMIN_ROW_ID },
			create: { id: ADMIN_ROW_ID, passwordHash },
			update: { passwordHash },
		});

		// Any session created under the old password must not survive the change, or the
		// change has revoked nothing.
		const { count } = await prisma.session.deleteMany({});

		process.stdout.write(`Administrator password set. Sessions ended: ${count}\n`);
	} finally {
		await prisma.$disconnect();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
