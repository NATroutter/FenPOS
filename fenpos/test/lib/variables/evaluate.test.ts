import { describe, expect, it, vi } from "vitest";
import type { VariableDefinition } from "@/lib/variables/definition";
import { evaluateVariable, type Formatting, type PrintContext } from "@/lib/variables/evaluate";

/**
 * A fixed instant, in UTC: 2026-08-25 21:07:03Z, a Tuesday.
 *
 * Chosen so every assertion below distinguishes the things that are easy to get backwards — the
 * hour is past noon, so a 24-hour pattern differs from a 12-hour one; the minute and the month are
 * different numbers, so `mm` and `MM` cannot be confused; and the Helsinki offset that day is +3,
 * so a zone-aware format cannot accidentally pass by formatting in UTC.
 */
const NOW = new Date("2026-08-25T21:07:03.000Z");

const CONTEXT: PrintContext = { deviceName: "counter", agentName: "helsinki", apiKeyName: "till-1" };
const HELSINKI: Formatting = { timeZone: "Europe/Helsinki", locale: "fi-FI" };
const UTC: Formatting = { timeZone: "UTC", locale: "en-US" };

const definition = (over: Partial<VariableDefinition>): VariableDefinition => ({
	name: "x",
	kind: "STATIC",
	value: null,
	pattern: null,
	offsetAmount: null,
	offsetUnit: null,
	source: null,
	overridable: false,
	description: null,
	...over,
});

describe("evaluateVariable", () => {
	describe("static", () => {
		it("returns the stored text unchanged", () => {
			const result = evaluateVariable(definition({ kind: "STATIC", value: "010-1234567" }), NOW, CONTEXT, UTC);
			expect(result).toBe("010-1234567");
		});

		it("does not interpret a brace in the value, so no recursion exists", () => {
			const result = evaluateVariable(definition({ kind: "STATIC", value: "see {other}" }), NOW, CONTEXT, UTC);
			expect(result).toBe("see {other}");
		});
	});

	describe("datetime", () => {
		it("formats in the configured zone, not UTC", () => {
			const time = definition({ kind: "DATETIME", pattern: "HH:mm" });
			expect(evaluateVariable(time, NOW, CONTEXT, UTC)).toBe("21:07");
			expect(evaluateVariable(time, NOW, CONTEXT, HELSINKI)).toBe("00:07");
		});

		it("rolls the date over when the zone pushes past midnight", () => {
			const date = definition({ kind: "DATETIME", pattern: "dd.MM.yyyy" });
			expect(evaluateVariable(date, NOW, CONTEXT, UTC)).toBe("25.08.2026");
			expect(evaluateVariable(date, NOW, CONTEXT, HELSINKI)).toBe("26.08.2026");
		});

		it("distinguishes minutes from months", () => {
			const full = definition({ kind: "DATETIME", pattern: "yyyy-MM-dd HH:mm:ss" });
			expect(evaluateVariable(full, NOW, CONTEXT, UTC)).toBe("2026-08-25 21:07:03");
		});

		it("writes day names in the configured locale", () => {
			const day = definition({ kind: "DATETIME", pattern: "EEEE" });
			expect(evaluateVariable(day, NOW, CONTEXT, UTC)).toBe("Tuesday");
			// date-fns's `EEEE` token renders in Finnish's grammatical "formatting" context, which
			// inflects the weekday name ("keskiviikkona", roughly "on Wednesday") rather than using
			// the standalone nominative ("keskiviikko", which `cccc` would produce). Verified against
			// date-fns's own fi locale data, not assumed.
			expect(evaluateVariable(day, NOW, CONTEXT, HELSINKI)).toBe("keskiviikkona");
		});

		it("applies a positive offset in days", () => {
			const returnBy = definition({
				kind: "DATETIME",
				pattern: "dd.MM.yyyy",
				offsetAmount: 14,
				offsetUnit: "DAYS",
			});
			expect(evaluateVariable(returnBy, NOW, CONTEXT, UTC)).toBe("08.09.2026");
		});

		it("applies a negative offset", () => {
			const backThen = definition({
				kind: "DATETIME",
				pattern: "dd.MM.yyyy",
				offsetAmount: -1,
				offsetUnit: "WEEKS",
			});
			expect(evaluateVariable(backThen, NOW, CONTEXT, UTC)).toBe("18.08.2026");
		});

		it("applies a month offset as a calendar month, not thirty days", () => {
			const nextMonth = definition({
				kind: "DATETIME",
				pattern: "dd.MM.yyyy",
				offsetAmount: 1,
				offsetUnit: "MONTHS",
			});
			expect(evaluateVariable(nextMonth, NOW, CONTEXT, UTC)).toBe("25.09.2026");
		});

		it("keeps a day offset on the same wall-clock time across a DST transition", () => {
			// All the offset tests above format in UTC, whose offset is constant and zero — that
			// hides the distinction this test exists to pin down: `DAYS` is a calendar unit in
			// `formatting.timeZone`, meaning "5 days later" means the *same wall-clock reading*,
			// five calendar days on, in the shop's own zone — not 5*24 real hours later.
			//
			// Helsinki leaves EEST (+3) for EET (+2) at 2026-10-25T01:00:00Z (04:00 local becomes
			// 03:00 local) — confirmed directly against `formatInTimeZone` before picking this
			// fixture, not assumed:
			//   2026-10-25T00:59:00Z -> 25.10.2026 03:59:00 +03:00
			//   2026-10-25T01:00:00Z -> 25.10.2026 03:00:00 +02:00
			const startOfTrip = new Date("2026-10-20T22:15:00.000Z"); // 21.10.2026 01:15 EEST (+3)
			const returnHome = definition({
				kind: "DATETIME",
				pattern: "dd.MM.yyyy HH:mm",
				offsetAmount: 5,
				offsetUnit: "DAYS",
			});

			// Derived from the rule, not from running the code: the starting Helsinki wall clock is
			// 21.10.2026 01:15; a calendar unit preserves that wall-clock reading and only advances
			// the date, so 5 days later reads 26.10.2026 01:15 regardless of the transition crossed
			// in between. (Adding 5*24 real hours instead would land on 00:15 — the bug this rule
			// replaced. See the elapsed-time test below for the contrasting case where that
			// arithmetic is exactly what's wanted.)
			expect(evaluateVariable(returnHome, startOfTrip, CONTEXT, HELSINKI)).toBe("26.10.2026 01:15");
		});

		it("shifts an hour offset by elapsed real time, unlike a day offset, across the same transition", () => {
			// The contrasting case to the test above: `HOURS` (and `MINUTES`) are elapsed real time,
			// not calendar units, so unlike `DAYS` they are immune to — and unaffected by — a DST
			// transition landing inside the span. This is the clearest statement of the rule: the
			// same kind of transition, the same target zone, but a different unit behaves visibly
			// differently, on purpose.
			//
			// Start at 25.10.2026 02:15 EEST (+3), confirmed against `formatInTimeZone`. Adding 3
			// real hours reaches 2026-10-25T02:15:00Z absolute, which is after the transition, so
			// Helsinki reads it at +2: 02:15 + 2:00 = 04:15. Three real hours pass, but the wall
			// clock only advances two, because the transition folded one hour back on itself — full
			// elapsed-time arithmetic, no calendar involved.
			const beforeTransition = new Date("2026-10-24T23:15:00.000Z"); // 25.10.2026 02:15 EEST (+3)
			const threeHoursOn = definition({
				kind: "DATETIME",
				pattern: "dd.MM.yyyy HH:mm",
				offsetAmount: 3,
				offsetUnit: "HOURS",
			});

			expect(evaluateVariable(threeHoursOn, beforeTransition, CONTEXT, HELSINKI)).toBe("25.10.2026 04:15");
		});

		it("computes a calendar offset the same way no matter what timezone the host process runs in", () => {
			// The defect this replaced was exactly this: `date-fns`'s plain `add` reads the host
			// process's own local clock fields, so the *same* definition, instant and formatting
			// zone produced different output depending on an OS setting nothing here controls.
			// Reproducing that defect required changing `process.env.TZ` mid-process and observing a
			// different result; proving it is fixed requires the same experiment now showing no
			// difference.
			//
			// Node/V8 can cache timezone resolution in ways that make a mid-process `process.env.TZ`
			// mutation silently not take effect on some platforms — which would make this test pass
			// for the wrong reason (nothing actually changed) rather than the right one (the
			// implementation ignores what did change). So the mutation's effect is asserted directly
			// via `Intl.DateTimeFormat`, which is what `date-fns`'s host-local arithmetic itself
			// consults, before trusting the comparison that follows.
			const startOfTrip = new Date("2026-10-20T22:15:00.000Z");
			const returnHome = definition({
				kind: "DATETIME",
				pattern: "dd.MM.yyyy HH:mm",
				offsetAmount: 5,
				offsetUnit: "DAYS",
			});

			const withHostUnset = evaluateVariable(returnHome, startOfTrip, CONTEXT, HELSINKI);

			// Kiritimati (UTC+14) is picked because it is about as far from Helsinki as a real zone
			// gets and its own calendar transitions fall nowhere near Finland's — so a match here
			// cannot be a coincidental alignment between the host's zone and the target zone, the
			// way it was in the original bug report (both happened to be Europe/Helsinki there).
			//
			// try/finally so a failed assertion below can't leave the stub applied for later tests.
			let withHostKiritimati: string;
			try {
				vi.stubEnv("TZ", "Pacific/Kiritimati");
				expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("Pacific/Kiritimati");
				withHostKiritimati = evaluateVariable(returnHome, startOfTrip, CONTEXT, HELSINKI);
			} finally {
				vi.unstubAllEnvs();
			}

			expect(withHostKiritimati).toBe(withHostUnset);
			expect(withHostKiritimati).toBe("26.10.2026 01:15");
		});

		it("refuses a pattern the formatter cannot read, naming the variable", () => {
			const broken = definition({ name: "when", kind: "DATETIME", pattern: "YYYY-QQ-oops" });
			expect(() => evaluateVariable(broken, NOW, CONTEXT, UTC)).toThrow(/when/);
		});
	});

	describe("context", () => {
		it("reads the device name", () => {
			const result = evaluateVariable(definition({ kind: "CONTEXT", source: "DEVICE_NAME" }), NOW, CONTEXT, UTC);
			expect(result).toBe("counter");
		});

		it("reads the agent name", () => {
			const result = evaluateVariable(definition({ kind: "CONTEXT", source: "AGENT_NAME" }), NOW, CONTEXT, UTC);
			expect(result).toBe("helsinki");
		});

		it("reads the key name", () => {
			const result = evaluateVariable(definition({ kind: "CONTEXT", source: "API_KEY_NAME" }), NOW, CONTEXT, UTC);
			expect(result).toBe("till-1");
		});

		it("gives an empty string when no key submitted the job", () => {
			const panelJob = { ...CONTEXT, apiKeyName: null };
			const result = evaluateVariable(definition({ kind: "CONTEXT", source: "API_KEY_NAME" }), NOW, panelJob, UTC);
			expect(result).toBe("");
		});
	});
});
