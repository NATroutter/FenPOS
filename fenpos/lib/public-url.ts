import "server-only";
import { headers } from "next/headers";
import { env } from "@/lib/env";

/**
 * The address agents should be told to dial.
 *
 * This value is copied off a screen and typed into a terminal in a shop, so getting it wrong
 * costs a site visit. It is resolved from configuration when available and from the request
 * otherwise, and the panel says which of the two it used.
 */

/** Where the displayed address came from, so the panel can qualify it honestly. */
export type AddressSource = "configured" | "request";

/** The address to display, and how it was determined. */
export interface PublicAddress {
	url: string;
	source: AddressSource;
}

/**
 * Resolves the address agents should connect to.
 *
 * `PUBLIC_URL` wins when set, because only an operator knows whether the address they reach
 * the panel on is the address a agent in another building can reach. Otherwise the request is
 * used: `X-Forwarded-Proto` and `X-Forwarded-Host` first, since behind a proxy the socket's
 * own view is the internal address rather than the published one.
 *
 * @returns the address and whether it was configured or inferred
 */
export async function getPublicAddress(): Promise<PublicAddress> {
	if (env.PUBLIC_URL) {
		return { url: stripTrailingSlash(env.PUBLIC_URL), source: "configured" };
	}

	const headerList = await headers();

	const forwardedHost = headerList.get("x-forwarded-host");
	const host = forwardedHost ?? headerList.get("host") ?? `localhost:${env.PORT}`;

	const forwardedProto = headerList.get("x-forwarded-proto")?.split(",")[0]?.trim();
	// Falls back to http rather than https: claiming https for a plain-HTTP install would
	// produce an address that fails to connect, and the agent refuses http:// deliberately.
	const proto = forwardedProto ?? "http";

	return { url: stripTrailingSlash(`${proto}://${host}`), source: "request" };
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
