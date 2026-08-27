import { describe, expect, it } from "vitest";
import { periodKeyFor, periodsFullyBefore } from "@/lib/archive/period";

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

describe("periodsFullyBefore", () => {
	it("returns whole months between the oldest row and the cutoff, oldest first", () => {
		const due = periodsFullyBefore(new Date("2026-01-10T00:00:00Z"), new Date("2026-04-15T00:00:00Z"));

		expect(due.map((period) => period.periodKey)).toEqual(["2026-01", "2026-02", "2026-03"]);
		expect(due[0].before).toEqual(new Date("2026-02-01T00:00:00.000Z"));
		expect(due[2].before).toEqual(new Date("2026-04-01T00:00:00.000Z"));
	});

	it("excludes the period the cutoff falls inside, because it is not fully aged out", () => {
		const due = periodsFullyBefore(new Date("2026-01-10T00:00:00Z"), new Date("2026-04-15T00:00:00Z"));

		// Goes red on a cutoff-based row sweep dressed up as a period sweep: 2026-04 contains rows
		// both older and newer than the cutoff, and archiving it would file live history.
		expect(due.map((period) => period.periodKey)).not.toContain("2026-04");
	});

	it("returns nothing when the oldest row is inside the cutoff's own period", () => {
		expect(periodsFullyBefore(new Date("2026-04-02T00:00:00Z"), new Date("2026-04-15T00:00:00Z"))).toEqual([]);
	});

	it("returns nothing when the cutoff precedes the oldest row", () => {
		expect(periodsFullyBefore(new Date("2026-04-10T00:00:00Z"), new Date("2026-01-15T00:00:00Z"))).toEqual([]);
	});

	it("crosses a year boundary", () => {
		const due = periodsFullyBefore(new Date("2025-11-20T00:00:00Z"), new Date("2026-02-10T00:00:00Z"));

		expect(due.map((period) => period.periodKey)).toEqual(["2025-11", "2025-12", "2026-01"]);
	});

	it("places a boundary in UTC, not the host's zone", () => {
		// 1 January in UTC, 31 December in a negative-offset zone: a local-time implementation would
		// emit 2025-12 as the last due period and file January's rows under December.
		const due = periodsFullyBefore(new Date("2025-12-05T00:00:00Z"), new Date("2026-01-01T00:30:00Z"));

		expect(due.map((period) => period.periodKey)).toEqual(["2025-12"]);
	});
});
