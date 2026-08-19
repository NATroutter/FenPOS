import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client";
import { writeOperatorPassword } from "../lib/auth/admin-credential";
import { hashPassword, passwordSchema } from "../lib/auth/password";

/**
 * Sets the administrator password from the command line.
 *
 * This is the recovery path for a forgotten password, not the setup path — the server
 * generates one on first boot and prints it. It stays a shell command because an
 * unauthenticated web route that can set the password is a takeover waiting to happen on a
 * server reachable before anyone configures it.
 *
 * Usage:
 *   pnpm admin:set-password "correct horse battery staple"
 *
 * The password is read from argv rather than prompted for, so the command works unattended in
 * a container. That does place it in shell history — acceptable for a recovery step, and the
 * reason the panel offers a password change of its own for routine rotation.
 *
 * Hashing, validation and the shape of the credential row are imported rather than repeated.
 * They were duplicated here on the belief that lib/auth was entirely `server-only`; only the
 * modules that reach for the request context and the session store are, and the ones this
 * needs never were. The copies had already drifted once, leaving this command writing a
 * password while the server went on advertising the generated one it had just replaced.
 */

async function main(): Promise<void> {
	const parsed = passwordSchema.safeParse(process.argv[2] ?? "");
	if (!parsed.success) {
		throw new Error(parsed.error.issues[0]?.message ?? 'Usage: pnpm admin:set-password "<password>"');
	}

	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
	}

	const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: databaseUrl }) });

	try {
		await writeOperatorPassword(prisma, await hashPassword(parsed.data));

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
