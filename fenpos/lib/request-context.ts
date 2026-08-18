import "server-only";
import { headers } from "next/headers";

/**
 * Details about the caller, derived from request headers.
 *
 * The client address is used to key rate limiting and is recorded against sessions and agent
 * pairings, so how it is derived is a security decision rather than a formatting one.
 */

/** Value recorded when the caller's address cannot be established. */
export const UNKNOWN_ADDRESS = "unknown";

/**
 * Resolves the caller's address.
 *
 * `X-Forwarded-For` is a list that each hop appends to, so the leftmost entry is whatever the
 * client claimed and is trivially forged — keying a rate limiter on it would let an attacker
 * bypass the limit entirely by varying one header. The **rightmost** entry is the address the
 * nearest proxy actually observed, which a client cannot append after.
 *
 * This assumes FenPOS runs behind exactly one reverse proxy, which is the documented
 * deployment. Running it directly exposed, or behind two proxies, changes which entry is
 * trustworthy — deploy it as documented, or this function needs revisiting.
 *
 * @returns the caller's address, or {@link UNKNOWN_ADDRESS} when no header identifies it
 */
export async function getClientAddress(): Promise<string> {
	const headerList = await headers();

	const forwardedFor = headerList.get("x-forwarded-for");
	if (forwardedFor) {
		const hops = forwardedFor
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		const nearest = hops.at(-1);
		if (nearest) {
			return nearest;
		}
	}

	// Set by the proxy itself rather than appended to, so it is only a useful fallback when
	// the proxy is configured to overwrite it. Consulted after X-Forwarded-For for that reason.
	return headerList.get("x-real-ip")?.trim() || UNKNOWN_ADDRESS;
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
