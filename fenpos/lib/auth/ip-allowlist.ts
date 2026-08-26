/**
 * Which addresses may reach the panel.
 *
 * Pure — no database, no request — so the matching rules can be pinned by tests. That matters more
 * here than in most modules: an allowlist that is wrong in the permissive direction protects nothing,
 * and one that is wrong in the restrictive direction locks every administrator out of a LAN appliance
 * with no remedy until phase 8's `pnpm auth:recover` exists.
 *
 * **Every uncertainty resolves to "not allowed".** A malformed entry, an address that cannot be
 * parsed, an IPv6 range — none of them match. The single exception is the empty list, which allows
 * everything, because that is the default and "unrestricted" is what it has to mean.
 *
 * IPv4 CIDR is supported; IPv6 is matched only exactly. An IPv6 range entry matches nothing rather
 * than matching everything, which is the safe direction to be incomplete in.
 *
 * No `server-only`: nothing here touches the database or the request, and a settings form that wanted
 * to show an operator whether their own address survives what they just typed would need exactly
 * these rules rather than a second copy of them.
 */

/**
 * Splits the stored setting into entries.
 *
 * Commas and newlines both separate, because an operator pasting a list from anywhere will use one or
 * the other and neither is worth refusing.
 *
 * @param raw the setting as stored
 * @returns the entries, trimmed, with blanks dropped
 */
export function parseAllowlist(raw: string): string[] {
	return raw
		.split(/[,\n]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/**
 * Whether an address may proceed.
 *
 * @param address the caller's address, as `getClientAddress` derived it
 * @param raw the allowlist setting as stored
 * @returns true when the list is empty, or when the address matches an entry
 */
export function addressAllowed(address: string, raw: string): boolean {
	const entries = parseAllowlist(raw);
	if (entries.length === 0) {
		return true;
	}

	const candidate = ipv4ToInteger(address);
	return entries.some((entry) => matches(candidate, address, entry));
}

/**
 * Whether one entry admits the address.
 *
 * @param candidate the address as an integer, or null when it is not IPv4
 * @param address the address as written, for the exact-match path
 * @param entry one allowlist entry
 * @returns whether this entry admits it
 */
function matches(candidate: number | null, address: string, entry: string): boolean {
	const slash = entry.indexOf("/");
	if (slash === -1) {
		return entry === address;
	}

	// A range only ever admits an IPv4 address: IPv6 CIDR is unsupported, and an address nothing could
	// parse is not one anybody put on a list.
	if (candidate === null) {
		return false;
	}

	const base = ipv4ToInteger(entry.slice(0, slash));
	const bits = Number.parseInt(entry.slice(slash + 1), 10);
	if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
		return false;
	}

	// `<<` is a 32-bit operation in JavaScript and `-1 << 32` is -1 rather than 0, so /0 needs its own
	// case: without it, a /0 entry would compare against a full mask and admit only itself.
	if (bits === 0) {
		return true;
	}
	const mask = -1 << (32 - bits);
	return (candidate & mask) === (base & mask);
}

/**
 * Reads a dotted-quad address as a 32-bit integer.
 *
 * @param value the address as written
 * @returns the integer, or null when it is not a well-formed IPv4 address
 */
function ipv4ToInteger(value: string): number | null {
	const parts = value.split(".");
	if (parts.length !== 4) {
		return null;
	}

	let total = 0;
	for (const part of parts) {
		// Checked against the digits themselves rather than trusting `parseInt`, which reads "10abc" as
		// 10 and would let a malformed entry match.
		if (!/^\d{1,3}$/.test(part)) {
			return null;
		}
		const octet = Number.parseInt(part, 10);
		if (octet > 255) {
			return null;
		}
		total = total * 256 + octet;
	}
	// Coerced to a signed 32-bit integer so it compares correctly against the masks above, which are
	// signed by construction.
	return total | 0;
}
