import "server-only";
import { headers } from "next/headers";
import { addressMatchesAny, normaliseAddress } from "@/lib/auth/ip-allowlist";
import { PEER_ADDRESS_HEADER } from "@/lib/net/peer-header";
import { type GlobalProxyTrust, globalProxyTrust } from "@/lib/settings/settings-service";

/**
 * Who the caller is.
 *
 * The client address keys the sign-in throttle, decides the address allowlist, and is written to
 * every audit row and session — so how it is derived is a security decision rather than a
 * formatting one, and getting it wrong is quiet in both directions. Too permissive and the throttle
 * counts a header an attacker chooses; too coarse and every visitor shares one bucket while the
 * allowlist matches a proxy instead of a person.
 *
 * **The connection is the source of truth; a header is hearsay.** The address starts as the peer
 * that actually opened the socket, which no caller can choose. A forwarding header is read only
 * when that peer is on `server.trustedProxies` — an operator-written list of the addresses they run
 * a proxy on, empty by default. Without that condition the throttle is keyed on a value the
 * attacker picks per request, the allowlist is passed by naming an address on it, and every audit
 * row records whatever was typed; with it, forging an address requires already being the proxy.
 *
 * **Which headers are believed is still configuration, not a guess.** There is no arrangement of
 * proxies that a fixed rule gets right: one proxy appending `X-Forwarded-For` wants the rightmost
 * entry, Cloudflare in front of nginx wants `CF-Connecting-IP` because by the time nginx has
 * appended its own view the rightmost entry is a Cloudflare edge. So `server.trustedProxyHeaders`
 * names them and `server.proxyIpPriority` says which end of a list to take, and the Settings page
 * shows the reader what all three settings resolve *their* address to — the only way to find out
 * whether they are right without reading the audit record afterwards and guessing.
 *
 * **Next handlers have no socket, so `server.ts` hands them one.** It stamps the peer onto
 * {@link PEER_ADDRESS_HEADER} after deleting any copy the caller sent, which is why that header is
 * the one input here that is not hearsay. A deployment that runs Next without `server.ts` in front
 * of it has no peer to read and every caller resolves to {@link UNKNOWN_ADDRESS} — coarse, and
 * deliberately so: the alternative is believing the caller.
 */

/** Value recorded when the caller's address cannot be established. */
export const UNKNOWN_ADDRESS = "unknown";

export { PEER_ADDRESS_HEADER } from "@/lib/net/peer-header";

/** An address, where it came from, and the connection it was measured against. */
export interface ResolvedAddress {
	/** The caller's address, or {@link UNKNOWN_ADDRESS}. */
	address: string;
	/** Which trusted header supplied it, or null when the connection's own peer did. */
	header: string | null;
	/** The peer that opened the connection, or null when this process cannot see one. */
	peer: string | null;
	/** Whether that peer is on the trusted-proxy list, and so may name somebody else. */
	peerTrusted: boolean;
}

/** Reads one header by its lowercase name. Both `Headers` and Node's own map satisfy this. */
export type HeaderLookup = (name: string) => string | undefined;

/**
 * Works out who the caller is, given the connection and what this install trusts.
 *
 * Pure, and separate from the two callers below, so the rules can be pinned by tests without a
 * request — the same reason `ip-allowlist.ts` is pure. Both the HTTP path and the agent link's
 * upgrade handshake resolve an address, and two copies of this is how they would come to disagree
 * about who somebody is between signing in and connecting.
 *
 * The peer decides whether the headers are read at all. Once they are, they are tried in the
 * configured order and the first one **present and non-empty** wins; a header that is configured but
 * absent is skipped rather than resolving to the peer, so listing `CF-Connecting-IP,
 * X-Forwarded-For` covers an install reached both through Cloudflare and directly on its own
 * address. A trusted proxy that sends none of them resolves to the proxy itself, which is the
 * honest answer: that is as much as the request said.
 *
 * @param lookup reads a header by its lowercase name
 * @param trust the peers to believe, the headers to read from them, and which entry to take
 * @param peer the address that opened the connection, when this process can see one
 * @returns the address, where it came from, and what the peer was
 */
export function resolveAddress(
	lookup: HeaderLookup,
	trust: GlobalProxyTrust,
	peer: string | undefined,
): ResolvedAddress {
	const socketPeer = peer && peer.trim() !== "" ? normaliseAddress(peer) : null;
	const peerTrusted = socketPeer !== null && addressMatchesAny(socketPeer, trust.proxies);
	const fallback: ResolvedAddress = {
		address: socketPeer ?? UNKNOWN_ADDRESS,
		header: null,
		peer: socketPeer,
		peerTrusted,
	};

	if (!peerTrusted) {
		return fallback;
	}

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
			return { address: normaliseAddress(chosen), header: name, peer: socketPeer, peerTrusted };
		}
	}

	return fallback;
}

/**
 * Resolves the caller's address, and says where it came from.
 *
 * Used by the Settings page to show an operator what their own configuration currently produces.
 * Everything else wants {@link getClientAddress}, which is this without the provenance.
 *
 * @returns the address, its source header, and the connection's peer
 */
export async function describeClientAddress(): Promise<ResolvedAddress> {
	const headerList = await headers();
	return resolveAddress(
		(name) => headerList.get(name) ?? undefined,
		await globalProxyTrust(),
		headerList.get(PEER_ADDRESS_HEADER) ?? undefined,
	);
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
