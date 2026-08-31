/**
 * How a signed-in account's avatar is chosen.
 *
 * Pure, and runs on the server. The panel renders the stored image via the authenticated
 * `/api/avatar/[userId]` route when one exists, and falls back to an initial otherwise.
 */

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
