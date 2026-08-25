import "server-only";
import { generatePassword, hashSecret, secretsMatch } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";

/**
 * The credential that claims an unconfigured install.
 *
 * An unauthenticated setup page would be a takeover waiting to happen on a server reachable
 * before anyone configures it, and a fixed default such as "admin" is the same hole with a
 * published key. A generated secret closes it while still requiring nothing of the operator
 * beyond reading the log they just started — the same reasoning the administrator password this
 * replaces was built on.
 *
 * Two things differ from that password, and both follow from the key being bound to nothing.
 *
 * **The plaintext is never stored.** `admin_auth` kept its generated password in the clear so it
 * could be reprinted on every start, for an operator who missed the first boot's output. That
 * trade is unnecessary here, because rotating costs nothing.
 *
 * **The key is replaced on every mint.** `registerRuntime` mints on each boot while the install
 * is unclaimed, so an operator who scrolled past the message restarts to get a fresh one — and a
 * key glimpsed by someone who should not have seen it stops working at the next restart.
 *
 * This module answers only "is this the key". Whether setup may *proceed* is a stricter question
 * with a second condition, and it is settled inside one transaction in `setup.ts`.
 */

/** The setup key row is a singleton, kept so by its fixed primary key rather than by convention. */
const SETUP_KEY_ROW_ID = 1;

/**
 * Whether an install has an owner yet.
 *
 * "Claimed" is defined as at least one user existing, not as the setup key being absent. The two
 * are equivalent on any install that got there normally, but only this definition holds when
 * something has gone wrong — a half-run setup, a hand-edited database — and it is the definition
 * `completeSetup` re-asserts.
 *
 * @returns true once any user exists
 */
export async function isInstallClaimed(): Promise<boolean> {
	return (await prisma.user.count()) > 0;
}

/**
 * Mints a setup key, replacing any previous one.
 *
 * Does nothing on a claimed install. That guard is not the security boundary — `completeSetup` is
 * — but it means the ordinary boot path cannot leave a usable setup credential lying around on a
 * configured server, which is worth having independently of what would happen if one did.
 *
 * @returns the plaintext key, or null when the install already has a user
 */
export async function rotateSetupKey(): Promise<string | null> {
	if (await isInstallClaimed()) {
		return null;
	}

	// Reuses the generated-password alphabet: this value is read off a terminal and typed into a
	// browser, so the characters mistaken for one another are already excluded from it, and it is
	// already grouped for legibility. 20 symbols over 32 is 100 bits.
	const plaintext = generatePassword();
	const keyHash = hashSecret(plaintext);

	await prisma.setupKey.upsert({
		where: { id: SETUP_KEY_ROW_ID },
		update: { keyHash, createdAt: new Date() },
		create: { id: SETUP_KEY_ROW_ID, keyHash },
	});

	return plaintext;
}

/**
 * Whether a candidate is the current setup key.
 *
 * Compared with {@link secretsMatch} rather than `===`. The hash is not secret in the way a
 * password hash is — it is a plain SHA-256 of a generated value — but a comparison that returns
 * early on the first differing byte leaks a prefix oracle, and there is no reason to hand one out.
 *
 * Returns false when no key is stored, which is what a claimed install looks like.
 *
 * @param candidate the key as typed
 * @returns whether it matches the stored hash
 */
export async function verifySetupKey(candidate: string): Promise<boolean> {
	const row = await prisma.setupKey.findUnique({
		where: { id: SETUP_KEY_ROW_ID },
		select: { keyHash: true },
	});

	if (!row) {
		return false;
	}

	return secretsMatch(row.keyHash, hashSecret(candidate));
}
