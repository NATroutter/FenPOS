/**
 * Password and profile rules shared by both sides of the wire.
 *
 * Deliberately a plain module: no `server-only`, no `node:` imports, nothing that reaches the
 * database or argon2's native binding. `password.ts` validates against these, and the profile
 * dialog and the initial-password hint quote them, so this has to be importable from a client
 * component without pulling `@node-rs/argon2` into the browser bundle along with it.
 */

/**
 * The floor `auth.minimumPasswordLength` can never fall below, and what `setup.ts` enforces
 * instead of that setting when creating the first account.
 *
 * There is no administrator yet at that moment to have configured the setting, so the built-in
 * floor is the only meaningful bound available — and it is a real one, never the silent zero a
 * missing check would leave behind.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;

/** Longest display name accepted. Long enough for a person or a shop, short enough for the footer. */
export const MAXIMUM_DISPLAY_NAME_LENGTH = 60;

/**
 * Phrases a password-length minimum for a sentence, pluralising "character" only where the count
 * requires it.
 *
 * Extracted because this project has broken exactly this kind of sentence at a boundary three
 * times already — "0 MB", "1 distinct URLs", "1 hours" — and `auth.minimumPasswordLength`'s own
 * hints are one more chance to do it a fourth time. `password.ts`'s validation message and every
 * "At least N characters" hint in the panel share this one function instead of each spelling out
 * their own plural.
 *
 * @param length the minimum to phrase, in characters
 * @returns the count with the correctly pluralised unit, e.g. "12 characters" or "1 character"
 */
export function minimumLengthPhrase(length: number): string {
	return `${length} ${length === 1 ? "character" : "characters"}`;
}

/**
 * The shape a password must have on this install.
 *
 * One value rather than four arguments, and that is the point. Three writers accept a password —
 * `/set-password`, the Settings change-password action, and `setAccountPassword` — and the failure
 * this is designed against is one of them enforcing a different rule than the others. Passing a
 * value makes "these three agree" something the type checker can see, and it means adding a fifth
 * requirement later is one field rather than three call-site edits.
 */
export interface PasswordPolicy {
	/** Shortest password accepted, never below {@link MINIMUM_PASSWORD_LENGTH}. */
	minimumLength: number;
	/** Whether both an upper-case and a lower-case letter are required. */
	requireMixedCase: boolean;
	/** Whether a digit is required. */
	requireDigit: boolean;
	/** Whether a character that is neither a letter, a digit, nor a space is required. */
	requireSymbol: boolean;
}

/**
 * Length only, which is the policy that has been in force until now.
 *
 * The three complexity rules default off, and deliberately: composition rules push people toward
 * `Password1!` and away from the long passphrases that are actually stronger, which is why current
 * guidance treats length as the requirement that matters. They exist because some installs answer to
 * a policy that demands them, not because they are an improvement.
 */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
	minimumLength: MINIMUM_PASSWORD_LENGTH,
	requireMixedCase: false,
	requireDigit: false,
	requireSymbol: false,
};

/** Whether a string carries both an upper-case and a lower-case letter. */
export function hasMixedCase(value: string): boolean {
	return /\p{Ll}/u.test(value) && /\p{Lu}/u.test(value);
}

/** Whether a string carries a digit. */
export function hasDigit(value: string): boolean {
	return /\p{Nd}/u.test(value);
}

/**
 * Whether a string carries a symbol.
 *
 * **A space does not count.** Spaces are what make a passphrase possible — `password.ts` allows them
 * on purpose — so counting one as a symbol would make this setting do nothing for exactly the
 * passwords somebody turned it on to constrain.
 */
export function hasSymbol(value: string): boolean {
	return /[^\p{L}\p{Nd}\s]/u.test(value);
}

/**
 * The policy as one sentence, for the hint under a password field.
 *
 * Lives here rather than beside each field so the three forms that take a password cannot describe
 * the rule differently from each other or from what the server enforces. The list is joined the way
 * English joins one — no comma before "and" at two items, commas before it at three — because this
 * project has broken exactly this kind of sentence at a boundary three times already.
 *
 * @param policy the policy in force
 * @returns e.g. "At least 12 characters, including a digit and a symbol."
 */
export function describePasswordPolicy(policy: PasswordPolicy): string {
	const extras: string[] = [];
	if (policy.requireMixedCase) {
		extras.push("upper and lower case");
	}
	if (policy.requireDigit) {
		extras.push("a digit");
	}
	if (policy.requireSymbol) {
		extras.push("a symbol");
	}

	const length = `At least ${minimumLengthPhrase(policy.minimumLength)}`;
	if (extras.length === 0) {
		return `${length}.`;
	}
	const joined = extras.length === 1 ? extras[0] : `${extras.slice(0, -1).join(", ")} and ${extras.at(-1)}`;
	return `${length}, including ${joined}.`;
}
