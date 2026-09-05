import { headers } from "next/headers";
import { describe, expect, it, vi } from "vitest";
import { getPeerAddress, PEER_ADDRESS_HEADER, resolveAddress, UNKNOWN_ADDRESS } from "@/lib/request-context";
import type { GlobalProxyTrust } from "@/lib/settings/settings-service";
import * as settings from "@/lib/settings/settings-service";

vi.mock("next/headers", () => ({
	headers: vi.fn(),
}));

/**
 * Tests for how the caller's address is worked out.
 *
 * **The deployment shapes are the cases**, because there is no fixed rule that gets them all right
 * and picking wrong is quiet in both directions: too permissive and the sign-in throttle counts a
 * header the caller chose, too coarse and every visitor shares one bucket while the allowlist
 * matches a proxy instead of a person.
 *
 * The one that motivated the header list being configurable at all is Cloudflare in front of nginx.
 * Cloudflare sets `X-Forwarded-For` to the visitor; nginx then appends the peer it saw, which is a
 * Cloudflare edge. The rightmost entry — the correct answer behind a single proxy — is then the
 * edge, so every visitor in the world resolves to one of a few hundred addresses.
 *
 * The one that motivated the *peer* being consulted first is the install with no proxy at all. Every
 * case below therefore names a peer, because "which headers do we believe" is only ever asked after
 * "is this peer allowed to answer that".
 */
describe("resolving the caller's address", () => {
	/** Builds a lookup over a plain header map, keyed the way both runtimes key theirs. */
	const from = (headers: Record<string, string>) => (name: string) => headers[name.toLowerCase()];

	/** The proxy every configured case below runs behind. */
	const PROXY = "10.0.0.2";
	/** A caller that is not it. */
	const DIRECT = "198.51.100.42";

	const rightmost: GlobalProxyTrust = { proxies: [PROXY], headers: ["x-forwarded-for"], priority: "rightmost" };
	const leftmost: GlobalProxyTrust = { proxies: [PROXY], headers: ["x-forwarded-for"], priority: "leftmost" };
	const cloudflare: GlobalProxyTrust = { proxies: [PROXY], headers: ["cf-connecting-ip"], priority: "rightmost" };

	describe("behind one reverse proxy", () => {
		it("takes the address the proxy observed", () => {
			// nginx with `$proxy_add_x_forwarded_for` appends its peer, so the rightmost entry is the
			// real client whatever the client claimed to its left.
			const resolved = resolveAddress(from({ "x-forwarded-for": "203.0.113.9" }), rightmost, PROXY);

			expect(resolved).toEqual({
				address: "203.0.113.9",
				header: "x-forwarded-for",
				peer: PROXY,
				peerTrusted: true,
			});
		});

		it("ignores entries the caller forged to the left of it", () => {
			const resolved = resolveAddress(from({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }), rightmost, PROXY);

			// This is the whole reason rightmost is the default: `1.2.3.4` is whatever the caller sent
			// and nothing can be appended after the proxy that actually saw them.
			expect(resolved.address).toBe("203.0.113.9");
		});

		it("resolves to the proxy itself when it forwards no header", () => {
			// The honest answer: that is as much as the request said. Not unknown, which would throw away
			// a real address, and not a header nobody sent.
			const resolved = resolveAddress(from({}), rightmost, PROXY);

			expect(resolved).toEqual({ address: PROXY, header: null, peer: PROXY, peerTrusted: true });
		});
	});

	describe("behind Cloudflare and nginx together", () => {
		// What both hops produce: Cloudflare writes the visitor, nginx appends the edge it saw.
		const both = { "x-forwarded-for": "203.0.113.9, 172.71.0.5", "cf-connecting-ip": "203.0.113.9" };

		it("resolves X-Forwarded-For to the Cloudflare edge, which is the bug", () => {
			const resolved = resolveAddress(from(both), rightmost, PROXY);

			// Pinned deliberately. This is correct behaviour for the setting as configured and the
			// reason the setting has to exist: no choice of end is right here, only a different header.
			expect(resolved.address).toBe("172.71.0.5");
		});

		it("resolves the visitor once CF-Connecting-IP is trusted instead", () => {
			const resolved = resolveAddress(from(both), cloudflare, PROXY);

			expect(resolved.address).toBe("203.0.113.9");
			expect(resolved.header).toBe("cf-connecting-ip");
		});

		it("is not fixed by taking the leftmost entry instead", () => {
			// It happens to give the right answer here, which is what makes it tempting and wrong: the
			// leftmost entry is the one a caller can write, so an install configured this way believes
			// whatever anybody sends through the proxy.
			expect(resolveAddress(from(both), leftmost, PROXY).address).toBe("203.0.113.9");
			expect(
				resolveAddress(from({ "x-forwarded-for": "1.2.3.4, 203.0.113.9, 172.71.0.5" }), leftmost, PROXY).address,
			).toBe("1.2.3.4");
		});
	});

	/**
	 * The case the peer check exists for. Every address-keyed control — the sign-in throttle, the
	 * pairing and setup limiters, the allowlist, every audit row — used to read a header with nothing
	 * checking that the caller was a proxy, so a peer connecting directly chose their own identity per
	 * request: the throttle counted a fresh key each time, and naming an allowed address passed the
	 * allowlist.
	 */
	describe("reached directly, with a header the caller wrote", () => {
		it("believes the connection rather than the claim", () => {
			const resolved = resolveAddress(from({ "x-forwarded-for": "203.0.113.9" }), rightmost, DIRECT);

			expect(resolved).toEqual({ address: DIRECT, header: null, peer: DIRECT, peerTrusted: false });
		});

		it("does not let a caller pass the allowlist by naming an address on it", () => {
			// The allowlist is often a private range, which is guessable. What stops the guess working is
			// that the address it is compared against never came from the caller.
			const resolved = resolveAddress(from({ "x-forwarded-for": "10.0.0.7" }), rightmost, DIRECT);

			expect(resolved.address).not.toBe("10.0.0.7");
		});

		it("gives each caller their own throttle key rather than one shared bucket", () => {
			// The other half of the same finding: with no trusted header present every direct caller used
			// to collapse onto a single `unknown` bucket, so one attacker exhausted the pairing limiter
			// and the sign-in throttle for every legitimate caller from any address.
			const first = resolveAddress(from({}), rightmost, "198.51.100.1");
			const second = resolveAddress(from({}), rightmost, "198.51.100.2");

			expect(first.address).not.toBe(second.address);
		});

		it("trusts nothing when the proxy list is empty, which is the default", () => {
			const nothing: GlobalProxyTrust = { proxies: [], headers: ["x-forwarded-for"], priority: "rightmost" };

			const resolved = resolveAddress(from({ "x-forwarded-for": "203.0.113.9" }), nothing, PROXY);

			expect(resolved).toEqual({ address: PROXY, header: null, peer: PROXY, peerTrusted: false });
		});
	});

	describe("matching the peer against the trusted list", () => {
		it("accepts a peer inside a configured range", () => {
			const range: GlobalProxyTrust = {
				proxies: ["172.16.0.0/12"],
				headers: ["x-forwarded-for"],
				priority: "rightmost",
			};

			const resolved = resolveAddress(from({ "x-forwarded-for": "203.0.113.9" }), range, "172.18.0.7");

			expect(resolved.address).toBe("203.0.113.9");
		});

		it("reads an IPv4-mapped peer as the IPv4 address an operator would have written", () => {
			// Node reports the peer of a connection accepted on a dual-stack socket this way. Without the
			// normalisation an entry of `127.0.0.1` would match nothing and the failure would be silent.
			const loopback: GlobalProxyTrust = {
				proxies: ["127.0.0.1"],
				headers: ["x-forwarded-for"],
				priority: "rightmost",
			};

			const resolved = resolveAddress(from({ "x-forwarded-for": "203.0.113.9" }), loopback, "::ffff:127.0.0.1");

			expect(resolved.address).toBe("203.0.113.9");
			expect(resolved.peer).toBe("127.0.0.1");
		});

		it("matches an IPv6 proxy exactly", () => {
			const six: GlobalProxyTrust = { proxies: ["::1"], headers: ["x-forwarded-for"], priority: "rightmost" };

			expect(resolveAddress(from({ "x-forwarded-for": "203.0.113.9" }), six, "::1").address).toBe("203.0.113.9");
			expect(resolveAddress(from({ "x-forwarded-for": "203.0.113.9" }), six, "::2").address).toBe("::2");
		});
	});

	describe("with no peer to read", () => {
		it("reads as unknown rather than believing a header", () => {
			// Reached when the panel is served by something other than `server.ts`, which is the only
			// thing that stamps the peer. Coarse, and the right direction to be wrong in.
			const resolved = resolveAddress(from({ "x-forwarded-for": "1.2.3.4" }), rightmost, undefined);

			expect(resolved).toEqual({ address: UNKNOWN_ADDRESS, header: null, peer: null, peerTrusted: false });
		});

		it("treats an empty peer header the same as an absent one", () => {
			expect(resolveAddress(from({}), rightmost, "").address).toBe(UNKNOWN_ADDRESS);
		});
	});

	describe("with several headers configured", () => {
		const either: GlobalProxyTrust = {
			proxies: [PROXY],
			headers: ["cf-connecting-ip", "x-forwarded-for"],
			priority: "rightmost",
		};

		it("prefers the first one present", () => {
			const resolved = resolveAddress(
				from({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9, 172.71.0.5" }),
				either,
				PROXY,
			);

			expect(resolved.address).toBe("203.0.113.9");
			expect(resolved.header).toBe("cf-connecting-ip");
		});

		it("falls through to the next when the first is absent", () => {
			// An install reachable both through Cloudflare and directly on its own address behind
			// nginx: one list covers both rather than needing the setting changed per route in.
			const resolved = resolveAddress(from({ "x-forwarded-for": "198.51.100.7" }), either, PROXY);

			expect(resolved.address).toBe("198.51.100.7");
			expect(resolved.header).toBe("x-forwarded-for");
		});

		it("skips a header that is present but empty", () => {
			const resolved = resolveAddress(
				from({ "cf-connecting-ip": "", "x-forwarded-for": "198.51.100.7" }),
				either,
				PROXY,
			);

			expect(resolved.header).toBe("x-forwarded-for");
		});

		it("skips a header holding nothing but separators", () => {
			const resolved = resolveAddress(
				from({ "cf-connecting-ip": " , ", "x-forwarded-for": "198.51.100.7" }),
				either,
				PROXY,
			);

			expect(resolved.header).toBe("x-forwarded-for");
		});
	});

	it("trims the spaces the header format puts after each comma", () => {
		expect(resolveAddress(from({ "x-forwarded-for": "  203.0.113.9  " }), rightmost, PROXY).address).toBe(
			"203.0.113.9",
		);
	});
});

describe("getPeerAddress", () => {
	it("answers from the connection alone, with no settings read", async () => {
		// This is what the two unauthenticated endpoints key their limiter on, and it has to be
		// answerable before anything touches the database — a request that is about to be refused
		// must not cost a query first.
		const reads = vi.spyOn(settings, "globalProxyTrust");
		vi.mocked(headers).mockResolvedValue(new Headers({ [PEER_ADDRESS_HEADER]: "203.0.113.5" }));

		await expect(getPeerAddress()).resolves.toBe("203.0.113.5");
		expect(reads).not.toHaveBeenCalled();
	});

	it("answers unknown when the process cannot see a peer", async () => {
		vi.mocked(headers).mockResolvedValue(new Headers());
		await expect(getPeerAddress()).resolves.toBe(UNKNOWN_ADDRESS);
	});
});
