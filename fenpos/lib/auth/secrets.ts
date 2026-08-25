import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Generation and verification of machine secrets: session tokens, agent tokens, API keys,
 * and pairing codes.
 *
 * These are all high-entropy values produced by a CSPRNG, which is why they are hashed with
 * SHA-256 rather than argon2. A slow KDF exists to make offline brute force of a
 * *human-chosen* password expensive; against 256 bits of random it buys nothing, while its
 * per-value salt would make lookup impossible — resolving an incoming bearer token would
 * degrade from one indexed query to a scan-and-verify over every row. Argon2 is used for
 * account passwords and nothing else (see password.ts).
 */

/** Bytes of entropy in a generated token. 32 bytes is 256 bits. */
const TOKEN_BYTES = 32;

/**
 * Crockford base32, which omits I, L, O and U.
 *
 * Chosen for the pairing code because it is read off a screen and typed into a terminal in
 * a noisy shop. The excluded letters are the ones mistaken for digits; decoding then maps
 * the mistakes back, so a operator who types O for 0 still pairs successfully.
 */
const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Characters in a pairing code, excluding the grouping dashes. */
const PAIRING_CODE_LENGTH = 12;

/** Characters per dash-separated group, purely for legibility. */
const PAIRING_GROUP_SIZE = 4;

/**
 * Crockford decoding substitutions, applied when reading a code an operator typed.
 *
 * These letters are never emitted, so accepting them costs no entropy: each maps to the one
 * character it is mistaken for. U maps to V because Crockford omits U from the alphabet.
 */
const CROCKFORD_SUBSTITUTIONS: Readonly<Record<string, string>> = {
	O: "0",
	I: "1",
	L: "1",
	U: "V",
};

/**
 * Generates a URL-safe random token.
 *
 * @param bytes entropy to draw; the default of 32 yields a 256-bit token
 * @returns a base64url-encoded token, safe in headers, cookies, and URLs
 */
export function generateToken(bytes: number = TOKEN_BYTES): string {
	return randomBytes(bytes).toString("base64url");
}

/**
 * Hashes a generated secret for storage.
 *
 * Deterministic by design: the same token always produces the same hash, which is what
 * allows an incoming credential to be resolved with a single indexed lookup.
 *
 * @param secret the plaintext token, key, or code
 * @returns lowercase hex SHA-256 of the secret
 */
export function hashSecret(secret: string): string {
	return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Compares two strings without leaking their contents through timing.
 *
 * Lengths are compared first and non-secretly, which is safe here because every caller
 * compares fixed-length hashes; an attacker learns nothing from a length mismatch that the
 * format did not already tell them.
 *
 * @param a first value
 * @param b second value
 * @returns whether the values are identical
 */
export function secretsMatch(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.length !== right.length) {
		return false;
	}
	return timingSafeEqual(left, right);
}

/**
 * Generates a pairing code.
 *
 * Drawn from a CSPRNG using rejection sampling rather than a modulo of a random byte: with
 * a 32-symbol alphabet and 256 possible byte values the modulo would be uniform here, but
 * the rejection form stays correct if the alphabet is ever changed to a size that does not
 * divide 256. Getting that wrong biases the code space and silently costs entropy.
 *
 * @returns a formatted code such as `AG7K-2M9P-X4TR`
 */
export function generatePairingCode(): string {
	const limit = Math.floor(256 / PAIRING_ALPHABET.length) * PAIRING_ALPHABET.length;
	const characters: string[] = [];

	while (characters.length < PAIRING_CODE_LENGTH) {
		for (const byte of randomBytes(PAIRING_CODE_LENGTH)) {
			if (byte < limit) {
				characters.push(PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]);
				if (characters.length === PAIRING_CODE_LENGTH) {
					break;
				}
			}
		}
	}

	const groups: string[] = [];
	for (let index = 0; index < characters.length; index += PAIRING_GROUP_SIZE) {
		groups.push(characters.slice(index, index + PAIRING_GROUP_SIZE).join(""));
	}
	return groups.join("-");
}

/** Characters in a generated secret of this shape. 20 over a 32-symbol alphabet is 100 bits. */
const GENERATED_PASSWORD_LENGTH = 20;

/**
 * Generates a random secret in the pairing alphabet's grouped format.
 *
 * `rotateSetupKey` (`setup-key.ts`) is the caller: this mints the plaintext key that claims an
 * unconfigured install. Uses the pairing alphabet, and for the same reason: this value is read
 * off a terminal and typed into a browser, so the characters mistaken for one another are
 * excluded. It is grouped for the same legibility, and the dashes count toward its length only as
 * literal characters — the entropy is in the 20 sampled symbols.
 *
 * @returns a secret such as `H7K2-M9PX-4TRB-N6QW-3JZY`
 */
export function generatePassword(): string {
	const limit = Math.floor(256 / PAIRING_ALPHABET.length) * PAIRING_ALPHABET.length;
	const characters: string[] = [];

	while (characters.length < GENERATED_PASSWORD_LENGTH) {
		for (const byte of randomBytes(GENERATED_PASSWORD_LENGTH)) {
			if (byte < limit) {
				characters.push(PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]);
				if (characters.length === GENERATED_PASSWORD_LENGTH) {
					break;
				}
			}
		}
	}

	const groups: string[] = [];
	for (let index = 0; index < characters.length; index += PAIRING_GROUP_SIZE) {
		groups.push(characters.slice(index, index + PAIRING_GROUP_SIZE).join(""));
	}
	return groups.join("-");
}

/**
 * Normalises a pairing code as typed by an operator into its canonical form.
 *
 * Applies Crockford decoding: case is folded, grouping characters are dropped, and the
 * letters excluded from the alphabet are mapped to the digits they resemble. This is what
 * makes the code forgiving to type without enlarging the space an attacker must search.
 *
 * @param input the raw code as entered, in any case and with any grouping
 * @returns the canonical code, or null when the input is not a well-formed code
 */
export function normalizePairingCode(input: string): string | null {
	const compact = [...input.toUpperCase().replace(/[\s-]/g, "")]
		.map((character) => CROCKFORD_SUBSTITUTIONS[character] ?? character)
		.join("");

	if (compact.length !== PAIRING_CODE_LENGTH) {
		return null;
	}
	for (const character of compact) {
		if (!PAIRING_ALPHABET.includes(character)) {
			return null;
		}
	}

	const groups: string[] = [];
	for (let index = 0; index < compact.length; index += PAIRING_GROUP_SIZE) {
		groups.push(compact.slice(index, index + PAIRING_GROUP_SIZE));
	}
	return groups.join("-");
}
