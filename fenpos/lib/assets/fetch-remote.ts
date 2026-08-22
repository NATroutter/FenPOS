import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { ApiError } from "@/lib/errors";
import { describeBytes } from "@/lib/format/bytes";
import { booleanSetting, integerSetting, stringSetting } from "@/lib/settings/settings-service";

/**
 * Fetching an image that a receipt names by URL, without letting the receipt point the server
 * at things it was never meant to reach.
 *
 * An `<image>` tag may reference a stored asset or a live `http(s)` URL. The stored asset was
 * uploaded by someone who was already signed in; the URL is different in kind. It is the one
 * place in this system where compiling a print job makes the server open a connection chosen by
 * whoever submitted the job.
 *
 * **Why that is dangerous here specifically.** The panel is not a machine sitting alone on the
 * public internet. It runs inside a shop, on the same LAN as the router's admin page, the other
 * printers, the POS terminals and whatever else is plugged in — and, on a hosted deployment,
 * next to a cloud metadata endpoint that hands out credentials to anything that asks. Anyone who
 * can submit a print job can therefore make this server issue an HTTP request on their behalf.
 * Worse than usual: the answer comes out of a thermal printer, so the response body is not merely
 * fetched, it is *rendered onto paper the attacker can read*. That is a complete exfiltration
 * channel out of a network that was supposed to be private.
 *
 * `<image>http://192.168.1.1/</image>` must not work. Neither must the dozen ways of writing that
 * which do not look like it.
 *
 * So every fetch through {@link fetchRemoteImage} is bounded six ways, and each bound exists
 * because removing it reopens something specific:
 *
 * - **Scheme.** `http` and `https` only. Without this, `file:///etc/passwd` and `gopher://` are
 *   reachable through the same code path.
 * - **Plain http.** An operator's own choice, on top of the scheme bound above: the
 *   `images.allowPlainHttp` setting can narrow "http or https" down to "https only" for a site
 *   that should never fetch in the clear. Checked wherever the scheme itself is checked — the
 *   initial URL and every redirect hop — so a plain-http redirect cannot slip past a scheme this
 *   install has switched off. See {@link requireSchemeAllowed}.
 * - **Address.** The *resolved* address must be publicly routable — see {@link IPV4_RULES} and
 *   {@link IPV6_RULES}. Checking the hostname text instead would be defeated by one DNS A record
 *   pointing inward, and checking the address and then connecting by hostname would be defeated
 *   by a second DNS answer — see {@link pinnedLookup}.
 * - **Host allowlist.** A second, independent bound an operator may add on top of the address
 *   check above: `images.allowedRemoteHosts` (empty by default, meaning any host). Applied after
 *   the scheme and address checks, never instead of them, and matched exactly on the hostname —
 *   no wildcards, no suffix match, so a listed `example.com` does not admit `sub.example.com`. See
 *   {@link requireHostAllowed}.
 * - **Redirects.** Followed at most {@link MAX_REDIRECTS} times, and every hop is put through the
 *   whole guard again. See {@link followTo} for why this is the easiest check to forget.
 * - **Time and size.** {@link remoteFetchTimeoutMs} for the entire operation and
 *   {@link MAX_REMOTE_IMAGE_BYTES} for the body, the latter enforced by counting bytes as they
 *   arrive rather than by measuring what was downloaded.
 *
 * Every refusal is an `ApiError`, so the caller reports it the same way as any other bad tag
 * argument rather than as a server fault. Fetching an internal address is not a recoverable
 * mistake; refusing a legitimate public image is. Where the two conflict, this module refuses.
 *
 * **Two things this guard deliberately does not stop, stated so nobody has to discover them.**
 *
 * A URL may carry credentials, and `node:http` turns them into a request header: given
 * `https://alice:hunter2@example.com/logo.png`, `urlToHttpOptions` lifts the userinfo into
 * `options.auth` and the client sends `Authorization: Basic YWxpY2U6aHVudGVyMg==`. Verified, not
 * assumed. So a job author can make this server send Basic credentials of their choosing to any
 * host — but only to a *public* one, since the address guard runs first, and only credentials they
 * supplied themselves. That is a small capability rather than a hole, and it is left in place
 * because image hosts behind Basic auth are a real thing. What is *not* left in place is those
 * credentials coming back out: {@link safeUrl} strips them from everything that reaches an error's
 * `details`, because `ApiError.toBody()` spreads `details` into the response body and the panel
 * writes the same details into a log a human reads. The credentials go to the server and nowhere
 * else.
 *
 * And a public address that is *routed* somewhere private — a hijacked prefix, or a public IP
 * NATed to an internal box — is indistinguishable from any other public address at this layer.
 * Nothing here can see it.
 */

/**
 * How long the whole fetch may take, in milliseconds. Read from the `images.remoteFetchTimeoutMs`
 * setting.
 *
 * One budget for everything — DNS, connect, redirects, body — not one per hop. Per-hop budgets
 * multiply: five redirects would buy five times the wait, and a print job that hangs behind a slow
 * attacker-controlled host is its own small denial of service.
 *
 * An operator's own call, the same reason `assets.maxUploadKb` is a setting rather than a constant:
 * a host on a slow link an install actually depends on and a hostile one dragging out the wait look
 * identical from here, and only the operator knows which risk they would rather take.
 *
 * @returns the configured budget, in milliseconds
 */
export async function remoteFetchTimeoutMs(): Promise<number> {
	return await integerSetting("images.remoteFetchTimeoutMs");
}

/**
 * The largest remote image this system will accept, in bytes.
 *
 * Two megabytes is generous for a receipt logo and small enough that a hostile server cannot use
 * it as a memory pump. It matters more than it looks: an image that gets past here is handed to
 * `ditherToRaster`, whose cost is quadratic-ish in pixel count — a few hundred kilobytes of PNG
 * can decode into hundreds of megabytes of bitmap and gigabytes of transient allocation. This cap
 * is the first size bound anywhere in the pipeline, so it is the one standing between a URL and
 * that. Enforced while the bytes stream in; see {@link readCapped}.
 */
export const MAX_REMOTE_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * How many redirects to follow before giving up.
 *
 * Enough for the CDN chains real image hosts use, few enough that a redirect loop ends quickly.
 */
export const MAX_REDIRECTS = 5;

/** The redirect statuses that carry a `Location` worth following. */
const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];

/** An IP address that has been checked and may be connected to. */
export interface PinnedAddress {
	/** The literal address, in the form `node:net` produces. */
	address: string;
	/** 4 or 6. */
	family: 4 | 6;
}

/** Turns a hostname into the addresses it currently points at. Injected so tests need no DNS. */
export type HostResolver = (hostname: string) => Promise<PinnedAddress[]>;

/**
 * One HTTP response, reduced to what the guard needs to decide about it.
 *
 * Deliberately smaller than a `Response`: this module must not be able to accidentally read a
 * whole body, and it must never follow a redirect without being asked. The body is an
 * `AsyncIterable` so that {@link readCapped} can stop pulling part-way through.
 */
export interface RemoteResponse {
	status: number;
	/** The `Location` header, or null if there was none. */
	location: string | null;
	/** `Content-Length` if the server sent a usable one. A hint from an untrusted party, nothing more. */
	contentLength: number | null;
	/** The response body, read at most once. */
	body: AsyncIterable<Uint8Array>;
	/** Abandons the response and its socket. Safe to call more than once, and after the body ends. */
	cancel: () => void;
}

/**
 * Opens one hop.
 *
 * Takes the addresses to connect to as a separate argument from the URL, which is the whole point:
 * the caller has already decided which addresses are acceptable, and the transport must not get a
 * second opinion from DNS. Injected so tests can script responses without a socket.
 *
 * It is a list rather than one address because every entry has already been checked, so there is
 * no reason to make the transport connect to only the first — see {@link pinnedLookup}.
 */
export type RemoteTransport = (url: URL, approved: PinnedAddress[], signal: AbortSignal) => Promise<RemoteResponse>;

/** Seams for tests. Every one of these has a working default; production passes none of them. */
export interface RemoteFetchOptions {
	resolve?: HostResolver;
	transport?: RemoteTransport;
	/** Overrides {@link remoteFetchTimeoutMs}. Tests use a few milliseconds so the suite stays fast. */
	timeoutMs?: number;
}

/**
 * Fetches an image named by a receipt, or refuses to.
 *
 * @param url the URL from the `<image>` tag, exactly as the caller wrote it
 * @param options test seams; omit them
 * @returns the response body, at most {@link MAX_REMOTE_IMAGE_BYTES} of it
 * @throws ApiError if the URL, the address behind it, any redirect hop, the size or the time
 *         taken is outside what this system will fetch
 */
export async function fetchRemoteImage(url: string, options: RemoteFetchOptions = {}): Promise<Buffer> {
	const resolve = options.resolve ?? systemResolver;
	const transport = options.transport ?? pinnedTransport;
	// Read before the deadline starts, so resolving these two settings never eats into the budget
	// that governs the fetch itself.
	const allowPlainHttp = await booleanSetting("images.allowPlainHttp");
	const allowedHosts = parseAllowedHosts(await stringSetting("images.allowedRemoteHosts"));
	const budget = options.timeoutMs ?? (await remoteFetchTimeoutMs());
	const signal = AbortSignal.timeout(budget);

	let target = parseTarget(url);
	requireSchemeAllowed(target, allowPlainHttp);

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const approved = await guardAddress(target, resolve, signal, budget);
		// After the scheme and address checks, never instead of them — see the module comment.
		requireHostAllowed(target, allowedHosts);

		let response: RemoteResponse;
		try {
			response = await untilAborted(transport(target, approved, signal), signal);
		} catch (thrown) {
			throw transportRefusal(target, signal, budget, thrown);
		}

		try {
			if (REDIRECT_STATUSES.includes(response.status)) {
				target = followTo(target, response, allowPlainHttp);
				continue;
			}
			if (response.status < 200 || response.status >= 300) {
				throw new ApiError("invalid_tag_argument", `${target.host} answered ${response.status} for this image.`, {
					url: safeUrl(target),
					status: response.status,
				});
			}
			try {
				return await untilAborted(readCapped(response, target), signal);
			} catch (thrown) {
				if (thrown instanceof ApiError) {
					throw thrown;
				}
				throw transportRefusal(target, signal, budget, thrown);
			}
		} finally {
			// Always, including on the way out with the bytes: an `IncomingMessage` that has been
			// fully read is already closed and this is a no-op, but one abandoned mid-body would
			// otherwise hold a socket open until the server gave up on it.
			response.cancel();
		}
	}

	throw new ApiError(
		"invalid_tag_argument",
		`This image redirected more than ${MAX_REDIRECTS} times, so it was not fetched.`,
		{ url: safeUrl(url) },
	);
}

/**
 * The URL with any embedded credentials removed, for reporting rather than requesting.
 *
 * Every `details.url` in this module goes through here. `ApiError.toBody()` spreads `details` into
 * the JSON response and the panel writes the same object into the log it displays, so a password in
 * `https://alice:hunter2@cdn.example.com/logo.png` would otherwise be echoed to whoever submitted
 * the job and then left sitting in a log. The credential belongs to the person who wrote the
 * receipt, which is why this is a leak rather than a breach — but copying a password into two new
 * places is not something a security control should be doing.
 *
 * The host and path survive, because a refusal that will not say which image it refused is not
 * much use to the person trying to fix their receipt.
 *
 * **Every** `details.url` in this module must go through here, including the two refusals inside
 * {@link followTo}. A redaction helper that ten of twelve call sites use is not a redaction helper,
 * and the two that were missed were both on the redirect path, where the URL is least likely to be
 * the one a reader is looking at and a leak is least likely to be noticed.
 *
 * Exported because that rule does not stop at this module's edge. Anything that *keeps* a URL that
 * came through here — the asset store writes one to `assets.source_url` for provenance — has to
 * keep the redacted form, or the credential this function exists to contain ends up somewhere far
 * more durable than an error message. Only the request itself gets the raw URL.
 *
 * @param url a parsed URL, or the raw string when it was too malformed to parse
 * @returns the same URL with userinfo removed
 */
export function safeUrl(url: URL | string): string {
	if (typeof url === "string") {
		try {
			return safeUrl(new URL(url));
		} catch {
			// It did not parse, so there is no structure to trust. Strip anything in the position
			// userinfo would occupy and accept that this is a best effort on a malformed string.
			//
			// `[^/]*@` and not `[^/@]*@`: an `@` is legal inside userinfo and WHATWG splits the
			// authority on the **last** one, so stopping at the first leaves the password in the
			// output. `//al@ice:hunter2@host/x` keeps `hunter2` in full under the narrower pattern.
			// Excluding `/` is what keeps the match inside the authority, so an `@` in a path —
			// `//host/logo@2x.png` — is left alone.
			return url.replace(/\/\/[^/]*@/, "//");
		}
	}
	if (url.username === "" && url.password === "") {
		return url.href;
	}
	const stripped = new URL(url.href);
	stripped.username = "";
	stripped.password = "";
	return stripped.href;
}

// --- Which addresses may be connected to ---

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
function blockedReason(address: string): string | null {
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

// --- The steps of a single hop ---

/**
 * Parses a URL and requires a scheme this system fetches over.
 *
 * @param url the caller's URL
 * @returns the parsed URL
 * @throws ApiError if it is not a URL, or not an http(s) one
 */
function parseTarget(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new ApiError("invalid_tag_argument", "This image is not a URL that can be fetched over http or https.", {
			url: safeUrl(url),
		});
	}
	requireWebScheme(parsed);
	return parsed;
}

/**
 * @param target a parsed URL
 * @throws ApiError unless the scheme is http or https
 */
function requireWebScheme(target: URL): void {
	if (target.protocol !== "http:" && target.protocol !== "https:") {
		throw new ApiError(
			"invalid_tag_argument",
			`Images may only be fetched over http or https, not ${target.protocol.replace(":", "")}.`,
			{ url: safeUrl(target) },
		);
	}
}

/**
 * Extends {@link requireWebScheme} with the operator's own choice of whether plain http may be
 * used at all, read from the `images.allowPlainHttp` setting.
 *
 * Called wherever {@link requireWebScheme} would otherwise be called on its own — the initial URL
 * in {@link fetchRemoteImage} and every redirect target in {@link followTo} — so a plain-http
 * redirect cannot slip past a scheme this install has switched off. `https` is never restricted;
 * the setting only narrows what `http` on its own is permitted to mean.
 *
 * @param target a parsed URL
 * @param allowPlainHttp the configured `images.allowPlainHttp`
 * @throws ApiError unless the scheme is http or https, or is http while plain http is disallowed
 */
function requireSchemeAllowed(target: URL, allowPlainHttp: boolean): void {
	requireWebScheme(target);
	if (target.protocol === "http:" && !allowPlainHttp) {
		throw new ApiError("invalid_tag_argument", "This install only fetches images over https; this one is plain http.", {
			url: safeUrl(target),
		});
	}
}

/**
 * Parses `images.allowedRemoteHosts`'s comma-separated text into the hostnames it names.
 *
 * Lower-cased here, once, rather than at the point of comparison: `requireHostAllowed` runs on
 * every hop of every fetch, while this setting changes only when an operator saves it, so there is
 * no reason to redo the casing work on every hop when it can be done once per fetch instead.
 *
 * @param raw the configured (or fallback) `images.allowedRemoteHosts`
 * @returns the hostnames the allowlist names, lower-cased; empty when the setting is empty, which
 *          means "any host"
 */
function parseAllowedHosts(raw: string): readonly string[] {
	if (raw.trim() === "") {
		return [];
	}
	return raw
		.split(",")
		.map((host) => host.trim().toLowerCase())
		.filter((host) => host !== "");
}

/**
 * Refuses a host outside the configured allowlist.
 *
 * A second, independent bound an operator may add on top of {@link guardAddress}, never a
 * replacement for it — called after that check has already approved the resolved address, on
 * every hop, so a redirect cannot reach a host the allowlist does not name. An empty allowlist
 * means "any host", which is the default and a real value rather than an unset one.
 *
 * **Matching is exact on the hostname. No wildcards, no suffix matching.** A listed `example.com`
 * must not admit `notexample.com` or `sub.example.com` — a suffix match (`hostname.endsWith(host)`)
 * would let both through, which is precisely the bug that makes an allowlist worthless: any
 * attacker-registered domain ending in an allowed name, or any subdomain of one, would pass. Array
 * membership (`includes`) is what actually enforces that; nothing here compares substrings.
 *
 * @param target the URL for this hop
 * @param allowedHosts the parsed `images.allowedRemoteHosts`, lower-cased; empty means unrestricted
 * @throws ApiError if the allowlist is non-empty and does not name this hostname exactly
 */
function requireHostAllowed(target: URL, allowedHosts: readonly string[]): void {
	if (allowedHosts.length === 0) {
		return;
	}
	// Same bracket-stripping as `guardAddress`, and the same reason: `URL.hostname` keeps the
	// brackets around an IPv6 literal, and nothing here wants them.
	const hostname = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (!allowedHosts.includes(hostname)) {
		throw new ApiError("invalid_tag_argument", `${hostname} is not on this install's list of allowed image hosts.`, {
			url: safeUrl(target),
		});
	}
}

/**
 * Works out which address this hop may connect to, and refuses if it is not one.
 *
 * A literal address in the URL is used as-is rather than being handed to a resolver, because
 * there is nothing to resolve — and because it keeps the numeric cases off the resolver seam
 * entirely, so they are checked by the same code in tests as in production. Note that the WHATWG
 * `URL` parser has already normalised the ways of disguising a literal: `http://0177.0.0.1/`,
 * `http://2130706433/` and `http://127.1/` all arrive here as `127.0.0.1`.
 *
 * **Every** answer is checked, not just the one that will be used. A hostname that resolves to a
 * public address and a private one is a hostname that gets to choose, and the choice is not this
 * code's to make.
 *
 * @param target the URL for this hop
 * @param resolve the resolver
 * @param signal the shared deadline
 * @param budget the deadline in milliseconds, for the message if it expires
 * @returns every address that may be connected to, in the order the resolver gave them
 * @throws ApiError if the hostname does not resolve, or resolves to anything not public
 */
async function guardAddress(
	target: URL,
	resolve: HostResolver,
	signal: AbortSignal,
	budget: number,
): Promise<PinnedAddress[]> {
	// `URL.hostname` keeps the brackets around an IPv6 literal; nothing downstream wants them.
	const hostname = target.hostname.replace(/^\[|\]$/g, "");

	// The WHATWG parser will not produce an empty host for http(s), so this should be unreachable.
	// It is checked anyway because `dns.lookup("")` is a documented compatibility quirk rather than
	// an error, and a resolver that answers a question this code never meant to ask is exactly the
	// kind of thing a guard should not be relying on being impossible.
	if (hostname === "") {
		throw new ApiError("invalid_tag_argument", "This image URL names no host to fetch it from.", {
			url: safeUrl(target),
		});
	}

	const literal = isIP(hostname);
	let candidates: PinnedAddress[];
	if (literal !== 0) {
		candidates = [{ address: hostname, family: literal === 4 ? 4 : 6 }];
	} else {
		try {
			candidates = await untilAborted(resolve(hostname), signal);
		} catch (thrown) {
			throw transportRefusal(target, signal, budget, thrown, `The hostname ${hostname} has no address.`);
		}
	}

	if (candidates.length === 0) {
		throw new ApiError("invalid_tag_argument", `The hostname ${hostname} did not resolve to any address.`, {
			url: safeUrl(target),
		});
	}

	for (const candidate of candidates) {
		const why = blockedReason(candidate.address);
		if (why !== null) {
			// Naming both the hostname and what it resolved to is the point of the message: the
			// person who wrote `<image>https://logo.example.com/…</image>` cannot otherwise tell
			// why a URL that looks entirely ordinary was refused.
			const found = candidate.address === hostname ? hostname : `${hostname}, which resolves to ${candidate.address},`;
			throw new ApiError("invalid_tag_argument", `This image cannot be fetched: ${found} is ${why}.`, {
				url: safeUrl(target),
				address: candidate.address,
			});
		}
	}

	// All of them, not just the first. Every one has been checked, so handing the whole set on is
	// no less safe than handing on one of them — and it is what lets a dual-stack host still work
	// on a network that can only reach one of its families. See {@link pinnedLookup}.
	return candidates;
}

/**
 * Works out where a redirect points, so the next pass through the loop can guard it.
 *
 * This is the check that is easiest to leave out and most expensive to leave out. `fetch` follows
 * redirects by default and does it inside the runtime, where no guard can see it: a URL on a
 * public CDN that passes every check here can answer `302 Location: http://169.254.169.254/`, and
 * a guard that validated only the URL it was handed has already lost. That is why this module
 * drives the redirects itself, one hop at a time, and why the loop in {@link fetchRemoteImage}
 * re-runs {@link guardAddress} on the result rather than treating a validated first hop as
 * permission for the rest of the chain.
 *
 * @param from the URL this response came from, which a relative `Location` is relative to
 * @param response the redirect response
 * @param allowPlainHttp the configured `images.allowPlainHttp`, checked the same as on the first hop
 * @returns the next URL, still unguarded
 * @throws ApiError if there is no usable `Location`, it leaves http(s), or it is plain http while
 *         plain http is disallowed
 */
function followTo(from: URL, response: RemoteResponse, allowPlainHttp: boolean): URL {
	if (response.location === null || response.location === "") {
		throw new ApiError("invalid_tag_argument", `${from.host} sent a ${response.status} redirect with no location.`, {
			url: safeUrl(from),
			status: response.status,
		});
	}

	let next: URL;
	try {
		next = new URL(response.location, from);
	} catch {
		throw new ApiError("invalid_tag_argument", `${from.host} redirected this image somewhere unreadable.`, {
			url: safeUrl(from),
		});
	}
	requireSchemeAllowed(next, allowPlainHttp);
	return next;
}

/**
 * Reads a body, stopping the moment it goes over the cap.
 *
 * The counting happens as the chunks arrive, which is the entire point. Reading the body and then
 * checking its length would be a cap that has already been exceeded by the time it is enforced —
 * the memory has been allocated, and a server that streams forever is never refused at all
 * because the check never runs.
 *
 * `Content-Length` is used only to refuse early. It is a claim by the server this module exists to
 * be careful about, so it can shorten a refusal but can never be what permits a read: a server
 * that declares one kilobyte and sends a hundred megabytes is cut off by the running total, the
 * same as one that declares nothing.
 *
 * @param response the successful response
 * @param target the URL, for the refusal message
 * @returns the body
 * @throws ApiError if the body is larger than {@link MAX_REMOTE_IMAGE_BYTES}
 */
async function readCapped(response: RemoteResponse, target: URL): Promise<Buffer> {
	if (response.contentLength !== null && response.contentLength > MAX_REMOTE_IMAGE_BYTES) {
		throw tooLarge(target, response.contentLength);
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of response.body) {
		total += chunk.byteLength;
		if (total > MAX_REMOTE_IMAGE_BYTES) {
			// Leaving the loop by throwing closes the iterator, which destroys the underlying
			// socket, so nothing keeps arriving after this point.
			throw tooLarge(target, total);
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, total);
}

function tooLarge(target: URL, seen: number): ApiError {
	return new ApiError(
		"invalid_tag_argument",
		`This image is larger than the ${describeBytes(MAX_REMOTE_IMAGE_BYTES)} limit.`,
		{
			url: safeUrl(target),
			limit: MAX_REMOTE_IMAGE_BYTES,
			seen,
		},
	);
}

/**
 * Turns a failed connection into a refusal the caller can read.
 *
 * The underlying error is kept as `cause` for the log and deliberately kept out of the message:
 * `connect ECONNREFUSED 93.184.216.34:80` reports what the server found at an address, and this
 * module's whole job is to not be a probe that answers questions about the network it sits in.
 *
 * @param target the URL being fetched
 * @param signal the shared deadline, consulted to tell "too slow" from "would not connect"
 * @param budget the deadline in milliseconds, for the message
 * @param cause the underlying failure
 * @param fallback message to use when the deadline was not the problem
 * @returns the refusal to throw
 */
function transportRefusal(
	target: URL,
	signal: AbortSignal,
	budget: number,
	cause: unknown,
	fallback = `${target.host} could not be reached for this image.`,
): ApiError {
	if (signal.aborted) {
		return new ApiError(
			"invalid_tag_argument",
			`This image timed out after ${budget} ms.`,
			{ url: safeUrl(target) },
			{
				cause,
			},
		);
	}
	return new ApiError("invalid_tag_argument", fallback, { url: safeUrl(target) }, { cause });
}

/**
 * Fails a promise when the deadline expires, whether or not the promise itself is listening.
 *
 * The real transport honours the signal, but the deadline must hold for any transport — including
 * a body that simply stops arriving mid-stream, which no `AbortSignal` wired into a request will
 * notice on its own. A print job may not hang because a remote server decided to be slow.
 *
 * The abandoned work is left to settle on its own; the caller cancels the response in a `finally`,
 * which is what actually closes the socket.
 *
 * @param work the operation to bound
 * @param signal the shared deadline
 * @returns the operation's result
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

// --- The real transport ---

/** Resolves a hostname the way the operating system would. */
const systemResolver: HostResolver = async (hostname) => {
	const answers = await lookup(hostname, { all: true, verbatim: true });
	return answers.map((answer) => ({ address: answer.address, family: answer.family === 4 ? 4 : 6 }));
};

/**
 * A `lookup` that ignores the hostname and can only answer with addresses already checked.
 *
 * This is what closes the gap between checking an address and connecting to it. Resolving a
 * hostname, approving what came back and then handing the *hostname* to an HTTP client asks DNS a
 * second question, and nothing obliges the second answer to match the first: a record with a
 * one-second TTL can return a public address to the check and a private one to the connection,
 * which is DNS rebinding and is a real attack, not a theoretical one. Giving the client a resolver
 * that cannot say anything except what was approved removes the second question entirely.
 *
 * The hostname is still what goes in the `Host` header and in TLS SNI and certificate validation,
 * because only DNS is overridden and not the request's idea of who it is talking to. Verified: a
 * request pinned to `127.0.0.1` for `logo.example.test` still sends `logo.example.test` as the SNI
 * name and still validates the certificate against it.
 *
 * **All** the approved addresses are offered, not just the first, and that is a correctness
 * requirement rather than a nicety. {@link systemResolver} asks with `verbatim: true`, so there is
 * no IPv4-first reordering and a dual-stack CDN commonly answers with its AAAA record first.
 * Offering only that one would pin an IPv6 address on a shop LAN with no IPv6 route, and a
 * perfectly ordinary public logo would fail where a plain `fetch` would have succeeded. Handing
 * over the whole set lets Node try them in turn (Happy Eyeballs) — and costs nothing, because
 * every address in the list has already been through {@link blockedReason}. The guard's promise is
 * that this list contains nothing private; it was never that the list has one entry.
 *
 * @param approved the addresses that passed the guard, in resolver order
 * @returns a lookup function for `node:http`
 */
function pinnedLookup(approved: PinnedAddress[]): LookupFunction {
	return (_hostname, options, callback) => {
		// Node asks with `all: true` when it is prepared to try several addresses and without it
		// otherwise, in which case only the first can be offered.
		if (options.all === true) {
			callback(
				null,
				approved.map((one) => ({ address: one.address, family: one.family })),
			);
			return;
		}
		callback(null, approved[0].address, approved[0].family);
	};
}

/**
 * Opens one hop against an address that has already been approved.
 *
 * Redirects are not followed here — they are handed back for {@link fetchRemoteImage} to guard.
 * `agent: false` turns off connection reuse: pooled sockets are keyed by host and port and know
 * nothing about the pinning, and rather than reason about whether a reused socket could ever
 * outlive the check that approved it, this simply never reuses one. An occasional logo fetch does
 * not need the handshake back.
 *
 * @param url the URL for this hop
 * @param approved the addresses approved for it
 * @param signal the shared deadline
 * @returns the response, with its body unread
 */
export const pinnedTransport: RemoteTransport = (url, approved, signal) =>
	new Promise<RemoteResponse>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}

		const send = url.protocol === "https:" ? httpsRequest : httpRequest;
		const request = send(
			url,
			{
				lookup: pinnedLookup(approved),
				agent: false,
				signal,
				headers: {
					// A preference, not a requirement. `image/*` alone would let a strict server
					// answer 406 to a URL that serves a perfectly good PNG, and what the bytes
					// actually are is decided by decoding them, not by what the server claims.
					accept: "image/*,*/*;q=0.8",
					// Some CDNs answer 403 to a request with no user agent at all.
					"user-agent": "FenPOS",
				},
			},
			(response) => {
				resolve({
					status: response.statusCode ?? 0,
					location: typeof response.headers.location === "string" ? response.headers.location : null,
					contentLength: parseContentLength(response.headers["content-length"]),
					body: response,
					cancel: () => {
						response.destroy();
						request.destroy();
					},
				});
			},
		);
		request.on("error", reject);
		request.end();
	});

/**
 * @param header the raw `Content-Length`
 * @returns the declared length, or null if the server did not send a usable one
 */
function parseContentLength(header: string | string[] | undefined): number | null {
	if (typeof header !== "string") {
		return null;
	}
	const declared = Number(header);
	return Number.isSafeInteger(declared) && declared >= 0 ? declared : null;
}
