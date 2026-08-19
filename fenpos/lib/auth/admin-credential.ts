import type { PrismaClient } from "../../generated/prisma/client";

/**
 * The shape of the administrator credential row, shared by the application and the CLI.
 *
 * Deliberately not marked `server-only` and deliberately taking its Prisma client as an
 * argument. `lib/auth/admin.ts` is server-only because it reaches for `lib/db`, the session
 * store and the request context; none of that is needed to write one row, and requiring it
 * is what forced the scripts to reimplement this and then drift from it.
 *
 * The drift was not hypothetical: when the generated-password marks were added, only the
 * application learned to clear them, so recovering a password from the CLI left the server
 * advertising a credential it had just invalidated.
 */

/** Fixed primary key of the singleton admin row. */
export const ADMIN_ROW_ID = 1;

/**
 * Records a password the operator chose.
 *
 * Clearing the generated marks is not a detail of this write, it *is* the write: a row whose
 * hash is operator-set but whose marks say otherwise makes the server reprint a dead password
 * and the panel demand a change that already happened. Doing both in one statement means no
 * caller can do half of it.
 *
 * Sessions are not touched here. Whether existing sessions survive is a policy question with
 * different answers for a routine change and a first-run bootstrap, so it stays with the
 * callers that know which they are.
 *
 * @param prisma a client connected to the FenPOS database
 * @param passwordHash the new password, already hashed
 */
export async function writeOperatorPassword(prisma: PrismaClient, passwordHash: string): Promise<void> {
	await prisma.adminAuth.upsert({
		where: { id: ADMIN_ROW_ID },
		create: { id: ADMIN_ROW_ID, passwordHash, isGenerated: false, generatedPassword: null },
		update: { passwordHash, isGenerated: false, generatedPassword: null },
	});
}
