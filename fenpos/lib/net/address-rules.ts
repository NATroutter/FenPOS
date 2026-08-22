import { BlockList, isIP } from "node:net";

/**
 * Which addresses this server is allowed to open an outbound connection to.
 *
 * This judgement started life inside the remote-image fetcher (`lib/assets/fetch-remote.ts`) as
 * the SSRF guard for `<image>` tags that name a live URL. Webhook delivery makes outbound requests
 * too, and needs the same refusal — a receipt author and a webhook target are both untrusted input
 * naming a place for this server to connect to, and there is exactly one correct answer to "is that
 * place safe to reach." Keeping two copies of a fail-closed allowlist is how one of them drifts
 * open: a range added here after an incident, or a comment explaining why one is missing, has to
 * apply everywhere this judgement is made, and a second copy is a second place to forget.
 *
 * This module knows about addresses only — nothing about images, webhooks, or HTTP. The scheme
 * check, the host allowlist, the redirect handling and everything else specific to a particular
 * transport stays with that transport; only "is this address on the public internet" lives here.
 */

/** One block of address space that is not on the public internet, and what to call it. */
interface AddressRule {
	/** Reads into "…is <why>." Named so the refusal says which rule fired, not merely that one did. */
	readonly why: string;
	readonly block: BlockList;
}

function rule(family: "ipv4" | "ipv6", address: string, prefix: number, why: string): AddressRule {
	const block = new BlockList();
	block.addSubnet(address, prefix, family);
	return { why, block };
}

/**
 * The IPv4 space that is not the public internet.
 *
 * Every entry is here because something answers on it inside a shop or a datacentre, and a
 * receipt must not be able to make the server talk to it. Deleting a line re-opens that range:
 *
 * - `169.254.0.0/16` is the one an attacker actually wants. `169.254.169.254` is the cloud
 *   metadata endpoint on AWS, GCP, Azure and DigitalOcean alike, and it hands out instance
 *   credentials over plain HTTP to anything that can reach it.
 * - `127.0.0.0/8` is the *whole* loopback block, not just `127.0.0.1`. On Linux every address in
 *   it answers, so a guard that special-cases `127.0.0.1` is bypassed by `127.0.0.2`.
 * - `10/8`, `172.16/12` and `192.168/16` are the shop's own LAN: the router's admin page, the
 *   other printers, the POS terminals.
 * - `100.64.0.0/10` is carrier-grade NAT, which is what the LAN looks like behind some ISP
 *   routers and on Tailscale.
 * - `0.0.0.0/8` reaches the local host on Linux — `0.0.0.0` is a working synonym for loopback.
 * - `192.0.0.0/24`, `198.18.0.0/15`, `224.0.0.0/4` and `240.0.0.0/4` are not routable on the
 *   public internet at all, so nothing legitimate can be behind them and anything that answers
 *   is local by definition. `240.0.0.0/4` also covers the `255.255.255.255` broadcast address.
 *
 * These are checked against IPv6 addresses too. `BlockList` matches an IPv4-mapped address such
 * as `::ffff:169.254.169.254` against IPv4 rules, which is how the mapped form is caught with the
 * right reason rather than a vague one.
 */
const IPV4_RULES: readonly AddressRule[] = [
	rule("ipv4", "0.0.0.0", 8, "an unspecified address, which reaches the local host"),
	rule("ipv4", "10.0.0.0", 8, "a private address on the local network"),
	rule("ipv4", "100.64.0.0", 10, "a carrier-grade NAT address"),
	rule("ipv4", "127.0.0.0", 8, "a loopback address"),
	rule("ipv4", "169.254.0.0", 16, "a link-local address, where cloud metadata services live"),
	rule("ipv4", "172.16.0.0", 12, "a private address on the local network"),
	rule("ipv4", "192.0.0.0", 24, "an IETF protocol assignment address"),
	rule("ipv4", "192.168.0.0", 16, "a private address on the local network"),
	rule("ipv4", "198.18.0.0", 15, "a benchmarking address"),
	rule("ipv4", "224.0.0.0", 4, "a multicast address"),
	rule("ipv4", "240.0.0.0", 4, "a reserved address"),
];

/**
 * The IPv6 space that is not the public internet.
 *
 * The last three entries are the important ones and they invert the approach: instead of listing
 * what to block, they block everything outside `2000::/3`, the only range IANA has allocated for
 * global unicast. IPv6 has far too many special-purpose prefixes to enumerate confidently, and a
 * denylist that misses one fails open. This fails closed — a new prefix that nobody here has
 * heard of is refused until someone deliberately allows it.
 *
 * The named rules above the catch-all exist so the refusal explains itself; without them
 * `fe80::1` would be reported as merely "not global unicast", which tells nobody anything.
 *
 * Note the ordering with {@link IPV4_RULES}: IPv4 rules run first, so `::ffff:127.0.0.1` is
 * reported as loopback and only a mapped address with no other objection falls through to
 * `::ffff:0:0/96`. That last rule refuses IPv4-mapped addresses even when the address inside them
 * is a perfectly good public one — `dns.lookup` does not produce the mapped form for a real
 * hostname, so seeing one means somebody wrote it deliberately, and the mapped form has a long
 * history of being handled inconsistently by parsers. Fail closed.
 *
 * `2002::/16` (6to4) and `64:ff9b::/96` (NAT64) embed an IPv4 address inside an IPv6 one and are
 * refused wholesale for the same reason: they are routes to the IPv4 world that do not look like
 * IPv4 addresses to a check that is not expecting them.
 */
const IPV6_RULES: readonly AddressRule[] = [
	rule("ipv6", "::ffff:0:0", 96, "an IPv4-mapped address"),
	rule("ipv6", "::1", 128, "a loopback address"),
	rule("ipv6", "::", 128, "an unspecified address"),
	rule("ipv6", "fe80::", 10, "a link-local address"),
	rule("ipv6", "fc00::", 7, "a unique-local address on the local network"),
	rule("ipv6", "ff00::", 8, "a multicast address"),
	rule("ipv6", "64:ff9b::", 96, "a NAT64 address, which tunnels to IPv4"),
	rule("ipv6", "2001::", 32, "a Teredo address, which tunnels to IPv4"),
	rule("ipv6", "2002::", 16, "a 6to4 address, which tunnels to IPv4"),
	rule("ipv6", "2001:db8::", 32, "a documentation address"),
	// Everything outside 2000::/3, expressed as the three blocks that make up its complement.
	rule("ipv6", "::", 3, "not a global unicast address"),
	rule("ipv6", "4000::", 2, "not a global unicast address"),
	rule("ipv6", "8000::", 1, "not a global unicast address"),
];

/**
 * Decides whether an address is one this system will connect to.
 *
 * @param address a literal IP address
 * @returns why the address is refused, or null if it is on the public internet
 */
export function blockedReason(address: string): string | null {
	const family = isIP(address);
	if (family === 0) {
		// A resolver that answered with something that is not an address is a resolver this code
		// does not understand, and an address it cannot classify is one it must not connect to.
		return "not an IP address";
	}

	const type = family === 4 ? "ipv4" : "ipv6";
	for (const candidate of IPV4_RULES) {
		if (candidate.block.check(address, type)) {
			return candidate.why;
		}
	}
	if (family === 6) {
		for (const candidate of IPV6_RULES) {
			if (candidate.block.check(address, "ipv6")) {
				return candidate.why;
			}
		}
	}
	return null;
}
