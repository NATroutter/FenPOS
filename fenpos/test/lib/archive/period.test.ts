import { describe, expect, it } from "vitest";
import { periodKeyFor } from "@/lib/archive/period";

describe("periodKeyFor", () => {
	it("names a period by calendar month in UTC", () => {
		expect(periodKeyFor(new Date("2026-07-04T12:00:00Z"))).toBe("2026-07");
		expect(periodKeyFor(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
	});

	it("does not shift a month boundary by the host's timezone", () => {
		// Goes red on a local-time implementation: this is 1 July in UTC, 30 June in Helsinki.
		expect(periodKeyFor(new Date("2026-07-01T00:30:00Z"))).toBe("2026-07");
	});
});
