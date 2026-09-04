import { beforeEach, describe, expect, it } from "vitest";
import { claimKeylessLogRow, resetKeylessLogBudgets } from "@/lib/api/keyless-log-budget";

/**
 * What a keyless refusal is allowed to cost.
 *
 * A `401` on the API is recorded deliberately — it is the line an operator asked "why has this till
 * stopped printing" needs. But the caller spent nothing to produce it and the row is durable, kept
 * for the log retention window and then archived for a year, on the volume the audit database shares.
 * The bound has to keep the evidence and drop the repetition.
 */
describe("budgeting the rows a keyless refusal may write", () => {
	const NOW = 1_000_000;

	beforeEach(resetKeylessLogBudgets);

	it("gives a fresh address a row", () => {
		expect(claimKeylessLogRow("198.51.100.1", NOW)).toEqual({ record: true, coalesced: 0 });
	});

	it("stops writing a row per request once the window's budget is spent", () => {
		const verdicts = Array.from({ length: 8 }, () => claimKeylessLogRow("198.51.100.2", NOW));

		expect(verdicts.filter((verdict) => verdict.record)).toHaveLength(5);
		expect(verdicts.slice(5).every((verdict) => !verdict.record)).toBe(true);
	});

	it("counts what it suppressed and says so on the next row it writes", () => {
		// Five rows, then twenty counted, then the window turns over and the next refusal reports them.
		for (let i = 0; i < 25; i++) {
			claimKeylessLogRow("198.51.100.3", NOW);
		}

		expect(claimKeylessLogRow("198.51.100.3", NOW + 61_000)).toEqual({ record: true, coalesced: 20 });
	});

	it("does not carry a debt forward once it has been reported", () => {
		for (let i = 0; i < 25; i++) {
			claimKeylessLogRow("198.51.100.4", NOW);
		}
		claimKeylessLogRow("198.51.100.4", NOW + 61_000);

		expect(claimKeylessLogRow("198.51.100.4", NOW + 61_001)).toEqual({ record: true, coalesced: 0 });
	});

	it("budgets each address separately, so one flood does not silence everyone else", () => {
		// The property the whole thing rests on, and the reason the address had to stop being a header
		// the caller writes: a shared bucket would let one attacker suppress every other caller's
		// refusals, which is worse than the flood.
		for (let i = 0; i < 50; i++) {
			claimKeylessLogRow("198.51.100.5", NOW);
		}

		expect(claimKeylessLogRow("203.0.113.9", NOW)).toEqual({ record: true, coalesced: 0 });
	});

	it("gives the budget back when the window turns over", () => {
		for (let i = 0; i < 5; i++) {
			claimKeylessLogRow("198.51.100.6", NOW);
		}
		expect(claimKeylessLogRow("198.51.100.6", NOW).record).toBe(false);

		expect(claimKeylessLogRow("198.51.100.6", NOW + 60_001).record).toBe(true);
	});

	it("keeps tracking the addresses still arriving when an attacker brings a range", () => {
		// The keys are caller-chosen, so the map is itself something to attack. Going past the ceiling
		// must cost the oldest entry rather than the bound — and must not cost the entry belonging to
		// the caller currently being served, or an attacker cycling addresses would reset their own
		// budget on every request and the coalescing would never engage.
		const last = "10.46.223.1";
		for (let i = 0; i < 12_000; i++) {
			claimKeylessLogRow(`10.${Math.floor(i / 256)}.${i % 256}.1`, NOW);
		}

		// `last` was the final address inserted and has spent one row of its five.
		const rest = Array.from({ length: 5 }, () => claimKeylessLogRow(last, NOW));

		expect(rest.filter((verdict) => verdict.record)).toHaveLength(4);
		expect(rest[4]).toEqual({ record: false, coalesced: 0 });
	});
});
