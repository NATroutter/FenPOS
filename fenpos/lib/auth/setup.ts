import "server-only";
import { credentialAccountRow } from "@/lib/auth/credential-account";
import { hashPassword, passwordSchema } from "@/lib/auth/password";
import { MINIMUM_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { hashSecret, secretsMatch } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Claiming an install, once and only once.
 *
 * This module is the seal. Everything around it — the setup page, the route guard, the fact that
 * `/setup` renders at all — is convenience. The boundary is the transaction below, and it is
 * placed here rather than in routing on purpose: a bypassed proxy, a crafted POST straight to the
 * server action, a stale bookmark, or a future refactor that forgets a guard all arrive at this
 * function, and this function re-asserts every condition itself.
 *
 * **Setup is permitted if and only if, within one transaction:** the setup key row exists, the
 * presented key matches it, and no user exists. The same transaction creates the superuser and
 * deletes the key row.
 *
 * Three properties follow, and they are the reason for the shape:
 *
 * - **No code path writes a setup key row while a user exists.** Re-opening setup is not a
 *   permission anyone holds; it is not expressible in this application. The only route back is
 *   the recovery CLI, which needs filesystem access and audits itself.
 * - **The race is closed — but not by SQL isolation.** Two simultaneous submissions cannot both
 *   succeed, and it would be natural to credit that to the transaction itself: `BEGIN`, some kind
 *   of database-level lock, isolation in the SQL sense. It rests on none of that — this driver's
 *   `BEGIN` is deferred, not `BEGIN IMMEDIATE`, so SQLite takes no write lock until the first
 *   write. What actually closes the race is that `@prisma/adapter-better-sqlite3` wraps a
 *   *synchronous* driver, and Node only interleaves two concurrent calls at an `await`. The
 *   winning submission's entire write phase — creating the user, creating the account, deleting
 *   the key row, and committing — runs to completion in one uninterrupted stretch before the
 *   losing submission's own `await`s ever let it resume. So when the loser's `tx.user.count()`
 *   re-read finally runs, it sees exactly the state the winner already committed: no key row, one
 *   user. The guarantee therefore depends on where the `await`s in this function fall and on the
 *   driver staying synchronous — introducing an `await` between the checks above and the writes
 *   below, or swapping in an async driver, would silently reopen the race. The concurrency tests
 *   in `setup.test.ts` — one with a shared email, one with distinct emails — exist to catch that
 *   regression.
 * - **A partial failure leaves nothing behind.** If the account write fails after the user row is
 *   created, the transaction rolls back and the key survives, so the operator can try again — as
 *   opposed to an install with a user and no credential, which would be sealed and unreachable.
 */

/** Everything the first-run form collects about the account it is creating. */
export interface SetupInput {
	/** The key as typed by the operator. */
	setupKey: string;
	name: string;
	email: string;
	password: string;
}

/**
 * Raised when setup is not permitted.
 *
 * A single error for every refusal — wrong key, no key, install already claimed — because the
 * caller must not be able to tell them apart. Distinguishing them would disclose whether an
 * install has been claimed to someone who has not proved they should know, which is precisely the
 * person asking. The server log records the difference.
 */
export class SetupRefusedError extends ApiError {
	constructor() {
		super("invalid_key", "That setup key is not correct.");
		this.name = "SetupRefusedError";
	}
}

/** The setup key row is a singleton, kept so by its fixed primary key. */
const SETUP_KEY_ROW_ID = 1;

/**
 * Creates the first superuser and seals setup.
 *
 * The password is validated against {@link MINIMUM_PASSWORD_LENGTH} rather than against
 * `auth.minimumPasswordLength`. The setting is administrator-configurable and there is no
 * administrator yet; the built-in floor is the only meaningful bound at this moment, and it is a
 * real one.
 *
 * The credential row is written directly rather than through Better Auth's `signUpEmail`, because
 * that endpoint is disabled — see `disableSignUp` in `auth.ts` — and because the whole point here
 * is that the user creation and the key deletion commit together or not at all, which a call out
 * to an HTTP-shaped API cannot join.
 *
 * @param input the key as typed, and the account to create
 * @returns the new superuser's id
 * @throws SetupRefusedError when the key is wrong, absent, or the install already has a user
 * @throws ApiError when the submitted details are not acceptable
 */
export async function completeSetup(input: SetupInput): Promise<{ userId: string }> {
	const parsedPassword = passwordSchema(MINIMUM_PASSWORD_LENGTH).safeParse(input.password);
	if (!parsedPassword.success) {
		throw new ApiError("invalid_type", parsedPassword.error.issues[0]?.message ?? "That password is not acceptable.");
	}

	const name = input.name.trim();
	if (name === "") {
		throw new ApiError("missing_field", "A name is required.");
	}

	const email = input.email.trim().toLowerCase();
	if (email === "") {
		throw new ApiError("missing_field", "An email address is required.");
	}

	// Hashed outside the transaction. Argon2id at the configured memory cost takes long enough
	// that holding SQLite's write lock across it would serialise every other writer behind a
	// deliberately slow computation, for no benefit — the hash depends on nothing the transaction
	// reads.
	const passwordHash = await hashPassword(parsedPassword.data);

	const userId = await prisma.$transaction(async (tx) => {
		const keyRow = await tx.setupKey.findUnique({
			where: { id: SETUP_KEY_ROW_ID },
			select: { keyHash: true },
		});

		if (!keyRow || !secretsMatch(keyRow.keyHash, hashSecret(input.setupKey))) {
			throw new SetupRefusedError();
		}

		// The second condition, and the one that makes this unrepeatable. Read inside the
		// transaction rather than before it, so a concurrent submission cannot slip between the
		// check and the insert.
		if ((await tx.user.count()) > 0) {
			throw new SetupRefusedError();
		}

		const now = new Date();
		const user = await tx.user.create({
			data: {
				id: crypto.randomUUID(),
				name,
				email,
				// Nothing sends mail, so there is no verification loop to run and marking the
				// address unverified forever would be a flag that never changes and never means
				// anything.
				emailVerified: true,
				// Better Auth's own role string, which its admin plugin reads. FenPOS
				// authorisation reads `isSuperuser`; both are set so the two never disagree.
				role: "admin",
				isSuperuser: true,
				mustChangePassword: false,
				createdAt: now,
				updatedAt: now,
			},
			select: { id: true },
		});

		await tx.account.create({ data: credentialAccountRow(user.id, passwordHash, now) });

		// The seal itself. In the same transaction as the user, so there is no instant at which
		// one exists without the other.
		await tx.setupKey.delete({ where: { id: SETUP_KEY_ROW_ID } });

		return user.id;
	});

	logger.info("Install claimed; setup is now sealed", { userId });

	return { userId };
}
