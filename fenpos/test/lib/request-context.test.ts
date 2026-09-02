import { describe, expect, it } from "vitest";
import { resolveAddress, UNKNOWN_ADDRESS } from "@/lib/request-context";
import type { GlobalProxyTrust } from "@/lib/settings/settings-service";

/**
 * Tests for how the caller's address is picked out of request headers.
 *
 * **The deployment shapes are the cases**, because there is no fixed rule that gets them all right
 * and picking wrong is quiet in both directions: too permissive and the sign-in throttle counts a
 * header the caller chose, too coarse and every visitor shares one bucket while the allowlist
 * matches a proxy instead of a person.
 *
 * The one that motivated this being configurable at all is Cloudflare in front of nginx. Cloudflare
 * sets `X-Forwarded-For` to the visitor; nginx then appends the peer it saw, which is a Cloudflare
 * edge. The rightmost entry — the correct answer behind a single proxy — is then the edge, so every
 * visitor in the world resolves to one of a few hundred addresses.
 */
describe("resolving the caller's address", () => {
	/** Builds a lookup over a plain header map, keyed the way both runtimes key theirs. */
	const from = (headers: Record<string, string>) => (name: string) => headers[name.toLowerCase()];

	const rightmost: GlobalProxyTrust = { headers: ["x-forwarded-for"], priority: "rightmost" };
	const leftmost: GlobalProxyTrust = { headers: ["x-forwarded-for"], priority: "leftmost" };
	const cloudflare: GlobalProxyTrust = { headers: ["cf-connecting-ip"], priority: "rightmost" };

	describe("behind one reverse proxy", () => {
		it("takes the address the proxy observed", () => {
			// nginx with `$proxy_add_x_forwarded_for` appends its peer, so the rightmost entry is the
			// real client whatever the client claimed to its left.
			const resolved = resolveAddress(from({ "x-forwarded-for": "203.0.113.9" }), rightmost);

			expect(resolved).toEqual({ address: "203.0.113.9", header: "x-forwarded-for" });
		});

		it("ignores entries the caller forged to the left of it", () => {
			const resolved = resolveAddress(from({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }), rightmost);

			// This is the whole reason rightmost is the default: `1.2.3.4` is whatever the caller sent
			// and nothing can be appended after the proxy that actually saw them.
			expect(resolved.address).toBe("203.0.113.9");
		});
	});

	describe("behind Cloudflare and nginx together", () => {
		// What both hops produce: Cloudflare writes the visitor, nginx appends the edge it saw.
		const both = { "x-forwarded-for": "203.0.113.9, 172.71.0.5", "cf-connecting-ip": "203.0.113.9" };

		it("resolves X-Forwarded-For to the Cloudflare edge, which is the bug", () => {
			const resolved = resolveAddress(from(both), rightmost);

			// Pinned deliberately. This is correct behaviour for the setting as configured and the
			// reason the setting has to exist: no choice of end is right here, only a different header.
			expect(resolved.address).toBe("172.71.0.5");
		});

		it("resolves the visitor once CF-Connecting-IP is trusted instead", () => {
			const resolved = resolveAddress(from(both), cloudflare);

			expect(resolved).toEqual({ address: "203.0.113.9", header: "cf-connecting-ip" });
		});

		it("is not fixed by taking the leftmost entry instead", () => {
			// It happens to give the right answer here, which is what makes it tempting and wrong: the
			// leftmost entry is the one a caller can write, so an install configured this way believes
			// whatever anybody sends it.
			expect(resolveAddress(from(both), leftmost).address).toBe("203.0.113.9");
			expect(resolveAddress(from({ "x-forwarded-for": "1.2.3.4, 203.0.113.9, 172.71.0.5" }), leftmost).address).toBe(
				"1.2.3.4",
			);
		});
	});

	describe("with no proxy", () => {
		it("reads as unknown rather than believing a header nothing set", () => {
			const resolved = resolveAddress(from({}), { headers: [], priority: "rightmost" });

			expect(resolved).toEqual({ address: UNKNOWN_ADDRESS, header: null });
		});

		it("ignores a header a caller sent when none is trusted", () => {
			// An install reached directly must not take the caller's word for who they are. Clearing
			// the header list is what says so.
			const resolved = resolveAddress(from({ "x-forwarded-for": "1.2.3.4" }), { headers: [], priority: "rightmost" });

			expect(resolved.address).toBe(UNKNOWN_ADDRESS);
		});
	});

	describe("with several headers configured", () => {
		const either: GlobalProxyTrust = { headers: ["cf-connecting-ip", "x-forwarded-for"], priority: "rightmost" };

		it("prefers the first one present", () => {
			const resolved = resolveAddress(
				from({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9, 172.71.0.5" }),
				either,
			);

			expect(resolved).toEqual({ address: "203.0.113.9", header: "cf-connecting-ip" });
		});

		it("falls through to the next when the first is absent", () => {
			// An install reachable both through Cloudflare and directly on its own address behind
			// nginx: one list covers both rather than needing the setting changed per route in.
			const resolved = resolveAddress(from({ "x-forwarded-for": "198.51.100.7" }), either);

			expect(resolved).toEqual({ address: "198.51.100.7", header: "x-forwarded-for" });
		});

		it("skips a header that is present but empty", () => {
			const resolved = resolveAddress(from({ "cf-connecting-ip": "", "x-forwarded-for": "198.51.100.7" }), either);

			expect(resolved.header).toBe("x-forwarded-for");
		});

		it("skips a header holding nothing but separators", () => {
			const resolved = resolveAddress(from({ "cf-connecting-ip": " , ", "x-forwarded-for": "198.51.100.7" }), either);

			expect(resolved.header).toBe("x-forwarded-for");
		});
	});

	it("trims the spaces the header format puts after each comma", () => {
		expect(resolveAddress(from({ "x-forwarded-for": "  203.0.113.9  " }), rightmost).address).toBe("203.0.113.9");
	});
});
