import "server-only";
import { headers } from "next/headers";
import { type GlobalProxyTrust, globalProxyTrust } from "@/lib/settings/settings-service";

/**
 * Details about the caller, derived from request headers.
 *
 * The client address keys the sign-in throttle, decides the address allowlist, and is written to
 * every audit row and session — so how it is derived is a security decision rather than a
 * formatting one, and getting it wrong is quiet in both directions. Too permissive and the throttle
 * counts a header an attacker chooses; too coarse and every visitor shares one bucket while the
 * allowlist matches a proxy instead of a person.
 *
 * **Which headers are believed is configuration, not a guess.** There is no arrangement of proxies
 * that a fixed rule gets right: one proxy appending `X-Forwarded-For` wants the rightmost entry,
 * Cloudflare in front of nginx wants `CF-Connecting-IP` because by the time nginx has appended its
 * own view the rightmost entry is a Cloudflare edge, and an install reached directly wants no header
 * trusted at all. So `server.trustedProxyHeaders` names them and `server.proxyIpPriority` says which
 * end of a list to take, and the Settings page shows the reader what those settings resolve *their*
 * address to — which is the only way to find out whether they are right without reading the audit
 * record afterwards and guessing.
 */

/** Value recorded when the caller's address cannot be established. */
export const UNKNOWN_ADDRESS = "unknown";

/** An address and the header it was taken from. */
export interface ResolvedAddress {
	/** The caller's address, or {@link UNKNOWN_ADDRESS}. */
	address: string;
	/** Which trusted header supplied it, or null when none did. */
	header: string | null;
}

/** Reads one header by its lowercase name. Both `Headers` and Node's own map satisfy this. */
export type HeaderLookup = (name: string) => string | undefined;

/**
 * Picks the caller's address out of the headers, given what this install trusts.
 *
 * Pure, and separate from the two callers below, so the rules can be pinned by tests without a
 * request — the same reason `ip-allowlist.ts` is pure. Both the HTTP path and the agent link's
 * upgrade handshake resolve an address, and two copies of this is how they would come to disagree
 * about who somebody is between signing in and connecting.
 *
 * Headers are tried in the configured order and the first one **present and non-empty** wins; a
 * header that is configured but absent is skipped rather than resolving to unknown, so listing
 * `CF-Connecting-IP, X-Forwarded-For` covers an install reached both through Cloudflare and
 * directly on its own address.
 *
 * @param lookup reads a header by its lowercase name
 * @param trust the headers to believe and which entry of a list to take
 * @returns the address and the header it came from
 */
export function resolveAddress(lookup: HeaderLookup, trust: GlobalProxyTrust): ResolvedAddress {
	for (const name of trust.headers) {
		const raw = lookup(name);
		if (!raw) {
			continue;
		}

		const hops = raw
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);

		const chosen = trust.priority === "leftmost" ? hops.at(0) : hops.at(-1);
		if (chosen) {
			return { address: chosen, header: name };
		}
	}

	return { address: UNKNOWN_ADDRESS, header: null };
}

/**
 * Resolves the caller's address, and says which header it came from.
 *
 * Used by the Settings page to show an operator what their own configuration currently produces.
 * Everything else wants {@link getClientAddress}, which is this without the provenance.
 *
 * @returns the address and its source header
 */
export async function describeClientAddress(): Promise<ResolvedAddress> {
	const headerList = await headers();
	return resolveAddress((name) => headerList.get(name) ?? undefined, await globalProxyTrust());
}

/**
 * Resolves the caller's address.
 *
 * @returns the caller's address, or {@link UNKNOWN_ADDRESS} when no trusted header identifies it
 */
export async function getClientAddress(): Promise<string> {
	return (await describeClientAddress()).address;
}

/**
 * Reads the caller's user agent, truncated to a storable length.
 *
 * @returns the user agent, or null when absent
 */
export async function getUserAgent(): Promise<string | null> {
	const headerList = await headers();
	const userAgent = headerList.get("user-agent");
	// Bounded because the value is attacker-controlled and is written to the database.
	return userAgent ? userAgent.slice(0, 512) : null;
}
