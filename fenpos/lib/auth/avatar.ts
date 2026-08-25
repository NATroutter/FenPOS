import { createHash } from "node:crypto";

/**
 * How a signed-in account's avatar is chosen.
 *
 * Two derivations, both pure, both run on the server. Keeping them out of the browser means the
 * address is never in client JavaScript and no hashing has to happen there — the panel renders a
 * URL that was already decided.
 */

/**
 * The Gravatar URL for an address.
 *
 * `d=404` is load-bearing. Gravatar's default is to *generate* an image for an address it does not
 * know, which would give an operator with no Gravatar account a procedural blob rather than their
 * own initial. Asking for a 404 makes it refuse, the `<img>` fails, and the fallback runs — which
 * is the same path an install with no internet takes.
 *
 * @param email the address, or null when none is set
 * @returns the URL, or null when there is nothing to hash and so nothing to request
 */
export function gravatarUrl(email: string | null): string | null {
	const normalised = (email ?? "").trim().toLowerCase();
	if (normalised === "") {
		return null;
	}

	const hash = createHash("sha256").update(normalised, "utf8").digest("hex");
	return `https://gravatar.com/avatar/${hash}?d=404`;
}

/**
 * The letter drawn when there is no image.
 *
 * Split with `Array.from` rather than indexed, because a display name is operator-supplied text
 * and its first character may be a surrogate pair — `charAt(0)` would render half of one.
 *
 * @param displayName the signed-in account's name
 * @returns a single uppercased character
 */
export function avatarInitial(displayName: string): string {
	const [first] = Array.from(displayName.trim());
	return (first ?? "A").toUpperCase();
}
