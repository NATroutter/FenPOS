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
		//
		// The `before` assertion matters as much as the `periodKey` one: on a positive-offset host a
		// local-time implementation still lands on "2025-12" as the last periodKey by coincidence, but
		// it computes `before` as 2025-12-31T22:00:00Z rather than the true UTC month boundary — so this
		// test goes red under a local-time implementation regardless of which way the host's offset
		// points. (A host whose offset is exactly zero is the one case nothing here can distinguish,
		// since local and UTC field accessors are then numerically identical — that is inherent, not
		// specific to this test.)
		const due = periodsFullyBefore(new Date("2025-12-05T00:00:00Z"), new Date("2026-01-01T00:30:00Z"));

		expect(due.map((period) => period.periodKey)).toEqual(["2025-12"]);
		expect(due[0].before).toEqual(new Date("2026-01-01T00:00:00.000Z"));
	});

	it("throws rather than loop forever when oldest is an invalid date", () => {
		// An invalid `oldest` makes `getUTCFullYear`/`getUTCMonth` both NaN, so the wraparound check
		// (`month === 12`) never fires and the walk would push `NaN-NaN` periods indefinitely instead of
		// stopping. Goes red on an implementation that omits this guard: the call itself would hang and
		// exhaust memory rather than return or throw.
		expect(() => periodsFullyBefore(new Date("not a date"), new Date("2026-01-15T00:00:00Z"))).toThrow(/oldest/);
	});

	it("throws rather than loop forever when cutoff is an invalid date", () => {
		// An invalid `cutoff` makes `cutoff.getTime()` NaN, and `before.getTime() > NaN` is false for
		// every `before`, so the aged-out check never trips and the walk never stops. Goes red on an
		// implementation that omits this guard: the call itself would hang and exhaust memory rather
		// than return or throw.
		expect(() => periodsFullyBefore(new Date("2026-01-10T00:00:00Z"), new Date("not a date"))).toThrow(/cutoff/);
	});
});
