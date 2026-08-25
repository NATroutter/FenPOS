import { describe, expect, it } from "vitest";
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
