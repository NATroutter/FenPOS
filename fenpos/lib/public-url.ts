import "server-only";
import { isIP } from "node:net";
import { headers } from "next/headers";
import { addressMatchesAny, normaliseAddress } from "@/lib/auth/ip-allowlist";
import { env } from "@/lib/env";
import { PEER_ADDRESS_HEADER } from "@/lib/net/peer-header";
import { globalProxyTrust, stringSetting } from "@/lib/settings/settings-service";

/**
 * The address agents should be told to dial.
 *
 * This value is copied off a screen and typed into a terminal in a shop, so getting it wrong
 * costs a site visit. It is resolved from Settings when an operator has saved one and from the
 * request otherwise, and the panel says which of the two it used.
 */

/** Where the displayed address came from, so the panel can qualify it honestly. */
export type AddressSource = "configured" | "request";

/** The address to display, how it was determined, and whether an agent will take it. */
export interface PublicAddress {
	url: string;
	source: AddressSource;
	/**
	 * Whether an agent would refuse this address.
	 *
	 * True for plain HTTP to anything but loopback. The agent enforces that as a property of the
	 * address rather than as a setting, and there is no flag to turn it off, so an address this is
	 * true of cannot be paired against — and an operator who is not told discovers it at the far
	 * end of a site visit.
	 */
	agentWillRefuse: boolean;
}

/**
 * Resolves the address agents should connect to.
 *
 * `server.publicUrl` wins when it holds anything but the empty string, because only an
 * operator knows whether the address they reach the panel on is the address a agent in
 * another building can reach.
 *
 * Otherwise the request is used — but a forwarding header is read only from a peer on
 * `server.trustedProxies`, which is the rule every other address in this system follows. This one
 * is copied off a screen and typed into a terminal at a shop, so a value a caller can choose is a
 * value an operator can be told to type.
 *
 * @returns the address, whether it was configured or inferred, and whether an agent will take it
 */
export async function getPublicAddress(): Promise<PublicAddress> {
	const configured = await stringSetting("server.publicUrl");
	if (configured !== "") {
		const url = stripTrailingSlash(configured);
		return { url, source: "configured", agentWillRefuse: refusedByAgent(url) };
	}

	const headerList = await headers();
	const trust = await globalProxyTrust();
	const peer = headerList.get(PEER_ADDRESS_HEADER);
	const trusted = peer !== null && addressMatchesAny(normaliseAddress(peer), trust.proxies);

	const forwardedHost = trusted ? headerList.get("x-forwarded-host") : null;
	const host = forwardedHost ?? headerList.get("host") ?? `localhost:${env.PORT}`;

	const forwardedProto = trusted ? headerList.get("x-forwarded-proto")?.split(",")[0]?.trim() : undefined;
	// Falls back to http rather than https: claiming https for a plain-HTTP install would
	// produce an address that fails to connect, and the agent refuses http:// deliberately.
	const proto = forwardedProto ?? "http";

	const url = stripTrailingSlash(`${proto}://${host}`);
	return { url, source: "request", agentWillRefuse: refusedByAgent(url) };
}

/**
 * Whether an agent's transport rule turns this address away.
 *
 * Mirrors the rule the agent applies before it opens a socket: https is required for everything
 * except a loopback literal, and a name is never resolved to decide it — `127.0.0.1.example` is a
 * name anyone can register.
 */
function refusedByAgent(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// Not an address at all, which the panel will show as-is and the agent will refuse for its
		// own reasons.
		return true;
	}

	if (parsed.protocol === "https:") {
		return false;
	}

	const host = parsed.hostname.replace(/^\[|\]$/g, "");
	if (host === "localhost") {
		return false;
	}
	return !(isIP(host) !== 0 && (host === "::1" || host.startsWith("127.")));
}

/**
 * Removes a trailing slash so the address concatenates predictably.
 *
 * @param url the address to normalise
 * @returns the address without a trailing slash
 */
function stripTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}
