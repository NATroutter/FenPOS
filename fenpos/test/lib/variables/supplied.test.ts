import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/errors";
import { readSuppliedVariables } from "@/lib/variables/supplied";

describe("readSuppliedVariables", () => {
	const read = (value: unknown, cap = 200) => readSuppliedVariables(value, cap);

	/** A text value as this now reads it. Written once so the shape change is one line, not thirty. */
	const text = (value: string) => ({ kind: "text" as const, text: value });

	const codeOf = (value: unknown, cap = 200): string => {
		try {
			readSuppliedVariables(value, cap);
		} catch (thrown) {
			if (thrown instanceof ApiError) {
				return thrown.code;
			}
			throw thrown;
		}
		throw new Error("expected a refusal");
	};

	it("is empty when the field is absent", () => {
		expect(read(undefined)).toEqual({});
		expect(read(null)).toEqual({});
	});

	it("reads names to values", () => {
		expect(read({ order_id: "1041", customer: "M. Virtanen" })).toEqual({
			order_id: text("1041"),
			customer: text("M. Virtanen"),
		});
	});

	it("refuses an array, which is an object but not this one", () => {
		expect(codeOf(["a"])).toBe("invalid_type");
	});

	it("refuses a string where an object belongs", () => {
		expect(codeOf("order_id=1041")).toBe("invalid_type");
	});

	it("refuses a name that is not slug-shaped", () => {
		expect(codeOf({ "Order Id": "1041" })).toBe("invalid_variable_name");
	});

	it("refuses a name containing a closing brace, which no markup could reference", () => {
		// Pins the reason this checks `nameSchema` rather than `VARIABLE_REFERENCE`: that regex is
		// anchored only at its start, so `{a}x}` matches it and a name of `a}x` would be accepted by
		// a check built on it.
		expect(codeOf({ "a}x": "1041" })).toBe("invalid_variable_name");
	});

	it("refuses a value that is neither a string nor an object", () => {
		expect(codeOf({ order_id: 1041 })).toBe("invalid_type");
		expect(codeOf({ order_id: true })).toBe("invalid_type");
		expect(codeOf({ order_id: null })).toBe("invalid_type");
	});

	it("refuses a value past the cap", () => {
		expect(codeOf({ note: "x".repeat(201) })).toBe("variable_too_long");
	});

	it("accepts a value exactly at the cap", () => {
		expect(read({ note: "x".repeat(200) })).toEqual({ note: text("x".repeat(200)) });
	});

	it("refuses a value carrying a control character", () => {
		expect(codeOf({ note: `a${String.fromCharCode(0x1b)}b` })).toBe("invalid_variable_value");
	});

	it("accepts an empty value, which is a real thing to send", () => {
		expect(read({ note: "" })).toEqual({ note: text("") });
	});

	/**
	 * The second accepted shape: the caller supplies what the date *is*, this install supplies how it
	 * reads. Nothing here renders anything — no clock is consulted in this module — so every test
	 * below is about shape and bounds, and the rendering ones live in `resolve-variables.test.ts`.
	 */
	describe("a date the caller asks this server to compute", () => {
		it("reads a pattern with no offset, which means the instant the job compiles at", () => {
			expect(read({ printed_at: { pattern: "dd.MM.yyyy" } })).toEqual({
				printed_at: { kind: "moment", pattern: "dd.MM.yyyy", offset: null },
			});
		});

		it("reads a pattern with an offset", () => {
			expect(read({ return_by: { pattern: "dd.MM.yyyy", offset: { amount: 14, unit: "DAYS" } } })).toEqual({
				return_by: { kind: "moment", pattern: "dd.MM.yyyy", offset: { amount: 14, unit: "DAYS" } },
			});
		});

		it("reads a negative offset, which is a date in the past", () => {
			expect(read({ ordered: { pattern: "dd.MM.", offset: { amount: -3, unit: "DAYS" } } })).toEqual({
				ordered: { kind: "moment", pattern: "dd.MM.", offset: { amount: -3, unit: "DAYS" } },
			});
		});

		it("refuses an amount without a unit, by the shape rather than by a refinement", () => {
			expect(codeOf({ return_by: { pattern: "dd.MM.yyyy", offset: { amount: 14 } } })).toBe("invalid_variable");
		});

		it("refuses a unit without an amount", () => {
			expect(codeOf({ return_by: { pattern: "dd.MM.yyyy", offset: { unit: "DAYS" } } })).toBe("invalid_variable");
		});

		it("refuses an object with no pattern at all", () => {
			expect(codeOf({ return_by: { offset: { amount: 14, unit: "DAYS" } } })).toBe("invalid_variable");
		});

		it("refuses an empty pattern", () => {
			expect(codeOf({ d: { pattern: "" } })).toBe("invalid_variable");
		});

		it("refuses a pattern past the bound a stored one obeys", () => {
			expect(codeOf({ d: { pattern: "d".repeat(121) } })).toBe("invalid_variable");
		});

		it("accepts a pattern exactly at that bound", () => {
			expect(read({ d: { pattern: "d".repeat(120) } })).toEqual({
				d: { kind: "moment", pattern: "d".repeat(120), offset: null },
			});
		});

		it("refuses an offset amount past the bound a stored one obeys", () => {
			expect(codeOf({ d: { pattern: "dd", offset: { amount: 100_001, unit: "DAYS" } } })).toBe("invalid_variable");
			expect(codeOf({ d: { pattern: "dd", offset: { amount: -100_001, unit: "DAYS" } } })).toBe("invalid_variable");
		});

		it("refuses a fractional offset amount", () => {
			expect(codeOf({ d: { pattern: "dd", offset: { amount: 1.5, unit: "DAYS" } } })).toBe("invalid_variable");
		});

		it("refuses an offset unit that is not one of the five", () => {
			expect(codeOf({ d: { pattern: "dd", offset: { amount: 1, unit: "FORTNIGHTS" } } })).toBe("invalid_variable");
		});

		it("refuses a caller-supplied time zone rather than quietly ignoring it", () => {
			// The failure this whole feature exists to prevent is a receipt whose dates are half in the
			// shop's zone and half in the caller's. Accepting the key and dropping it would print a date
			// in a zone the caller did not ask for, silently — refusing says so.
			expect(codeOf({ d: { pattern: "dd", timezone: "America/New_York" } })).toBe("invalid_variable");
			expect(codeOf({ d: { pattern: "dd", locale: "en-US" } })).toBe("invalid_variable");
		});

		it("refuses a 'kind' field, because the shape is the kind", () => {
			expect(codeOf({ d: { kind: "CONTEXT", source: "PAPER_WIDTH" } })).toBe("invalid_variable");
		});

		it("refuses an array, which is an object but not this one either", () => {
			expect(codeOf({ d: ["dd.MM.yyyy"] })).toBe("invalid_type");
		});

		it("does not measure the pattern against the value cap, because the rendered text is what prints", () => {
			// A 120-character pattern under a 10-character cap is fine here: what a cap applies to is
			// the text that reaches paper, and that text does not exist until `resolveVariables` renders
			// it. Capping the pattern instead would refuse `EEEE, dd MMMM yyyy` for an install whose cap
			// is short, while letting a shorter pattern of quoted literals through — the wrong end.
			expect(read({ d: { pattern: "d".repeat(120) } }, 10)).toEqual({
				d: { kind: "moment", pattern: "d".repeat(120), offset: null },
			});
		});
	});
});
