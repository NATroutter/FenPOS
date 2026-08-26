import { createHmac } from "node:crypto";

/**
 * Computing real TOTP codes against a real secret, the way an authenticator app would.
 *
 * Shared by every test that needs to prove a code was accepted rather than merely that some
 * six-digit string was — `test/lib/auth/two-factor.test.ts` for enrolment,
 * `test/app/(auth)/login/actions.test.ts` for the sign-in challenge, and
 * `test/lib/auth/session-rotation.test.ts` for what confirming one does to the session all drive the
 * same plugin against the same kind of secret, and a second, drifted copy of this math in any of
 * them would be the one place a bug could hide from all three.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decodes the plugin's stored base32 secret.
 *
 * Not exported: {@link totp} is the whole of what callers want, and an exported decoder with no
 * importer was only ever an invitation to hand-roll the rest of the algorithm beside it.
 *
 * @param secret the base32 text the plugin handed back in the enrolment URI
 * @returns the raw key bytes
 * @throws Error when a character is not in the base32 alphabet
 */
function fromBase32(secret: string): Buffer {
	let bits = "";
	for (const character of secret.replace(/=+$/, "").toUpperCase()) {
		const index = BASE32.indexOf(character);
		if (index === -1) {
			throw new Error(`Not base32: ${character}`);
		}
		bits += index.toString(2).padStart(5, "0");
	}
	const bytes: number[] = [];
	for (let at = 0; at + 8 <= bits.length; at += 8) {
		bytes.push(Number.parseInt(bits.slice(at, at + 8), 2));
	}
	return Buffer.from(bytes);
}

/**
 * RFC 6238, SHA-1, six digits, thirty-second step — the defaults every authenticator assumes.
 *
 * @param secret the base32 secret the plugin minted
 * @param at the instant to compute the code for; defaults to now
 * @returns the six-digit code an authenticator would be showing at that instant
 */
export function totp(secret: string, at: number = Date.now()): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
	const digest = createHmac("sha1", fromBase32(secret)).update(counter).digest();
	const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
	const value = digest.readUInt32BE(offset) & 0x7fffffff;
	return (value % 1_000_000).toString().padStart(6, "0");
}
