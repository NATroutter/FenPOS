import { describe, expect, it } from "vitest";
import { blockedReason } from "@/lib/net/address-rules";

/**
 * The address classification behind every outbound connection this server makes.
 *
 * Fails closed by design: anything not recognisable as global unicast is refused, so a prefix
 * nobody here has heard of is blocked until someone deliberately allows it. These cases are the
 * ones a reviewer should be able to check by eye — the loopback, private and link-local addresses
 * that a URL pointing "outward" must never resolve to.
 */

describe("blockedReason", () => {
	it("permits ordinary public addresses", () => {
		expect(blockedReason("93.184.216.34")).toBeNull();
		expect(blockedReason("2606:2800:220:1:248:1893:25c8:1946")).toBeNull();
	});

	it("refuses loopback", () => {
		expect(blockedReason("127.0.0.1")).toMatch(/loopback/i);
		expect(blockedReason("::1")).toMatch(/loopback/i);
	});

	it("refuses private ranges", () => {
		expect(blockedReason("10.0.0.1")).not.toBeNull();
		expect(blockedReason("192.168.1.1")).not.toBeNull();
		expect(blockedReason("172.16.0.1")).not.toBeNull();
	});

	it("refuses link-local, including the cloud metadata address", () => {
		expect(blockedReason("169.254.169.254")).not.toBeNull();
		expect(blockedReason("fe80::1")).not.toBeNull();
	});

	it("reports an IPv4-mapped address by its IPv4 nature, which is what a reader needs", () => {
		expect(blockedReason("::ffff:127.0.0.1")).toMatch(/loopback/i);
	});
});
