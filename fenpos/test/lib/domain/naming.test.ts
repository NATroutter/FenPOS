import { describe, expect, it } from "vitest";
import { MAX_NAME_LENGTH, nameSchema, toNameCandidate } from "@/lib/domain/naming";

describe("nameSchema", () => {
	it("accepts a simple slug", () => {
		expect(nameSchema.safeParse("kitchen").success).toBe(true);
	});

	it("accepts dashes, underscores and digits after the first character", () => {
		expect(nameSchema.safeParse("kitchen-2").success).toBe(true);
		expect(nameSchema.safeParse("bar_left").success).toBe(true);
		expect(nameSchema.safeParse("2nd-floor").success).toBe(true);
	});

	it("rejects an empty name", () => {
		expect(nameSchema.safeParse("").success).toBe(false);
	});

	it("rejects upper case, so a name reads the same in a URL and a log", () => {
		expect(nameSchema.safeParse("Kitchen").success).toBe(false);
	});

	it("rejects spaces and punctuation that would need escaping in a path", () => {
		expect(nameSchema.safeParse("kitchen printer").success).toBe(false);
		expect(nameSchema.safeParse("kitchen/printer").success).toBe(false);
		expect(nameSchema.safeParse("../etc").success).toBe(false);
	});

	it("rejects a leading dash, which would read as a flag on the agent's command line", () => {
		expect(nameSchema.safeParse("-kitchen").success).toBe(false);
		expect(nameSchema.safeParse("_kitchen").success).toBe(false);
	});

	it("rejects a name longer than the limit", () => {
		expect(nameSchema.safeParse("a".repeat(MAX_NAME_LENGTH)).success).toBe(true);
		expect(nameSchema.safeParse("a".repeat(MAX_NAME_LENGTH + 1)).success).toBe(false);
	});
});

describe("toNameCandidate", () => {
	it("lowercases and joins words with dashes", () => {
		expect(toNameCandidate("Kitchen Printer")).toBe("kitchen-printer");
	});

	it("strips diacritics so similar names do not diverge", () => {
		expect(toNameCandidate("Café")).toBe("cafe");
	});

	it("collapses runs of punctuation into a single separator", () => {
		expect(toNameCandidate("bar // left")).toBe("bar-left");
	});

	it("removes leading and trailing separators", () => {
		expect(toNameCandidate("  Kitchen  ")).toBe("kitchen");
		expect(toNameCandidate("--kitchen--")).toBe("kitchen");
	});

	it("truncates to the maximum length", () => {
		expect(toNameCandidate("a".repeat(MAX_NAME_LENGTH + 20))).toHaveLength(MAX_NAME_LENGTH);
	});

	it("produces a value the schema accepts", () => {
		expect(nameSchema.safeParse(toNameCandidate("Kitchen Printer #2")).success).toBe(true);
	});

	describe("live input", () => {
		/**
		 * Normalising every keystroke is how the field works, so the sequence matters as much
		 * as the end state. Trimming the trailing separator mid-word silently deletes the space
		 * the operator just typed, and "Kitchen Printer" arrives as "kitchenprinter".
		 */
		function typeOut(text: string): string {
			let value = "";
			for (const character of text) {
				value = toNameCandidate(value + character, { keepTrailingSeparator: true });
			}
			return value;
		}

		it("preserves the word boundary while a name is being typed", () => {
			expect(typeOut("Kitchen Printer")).toBe("kitchen-printer");
		});

		it("keeps the separator visible immediately after the space", () => {
			expect(typeOut("Kitchen ")).toBe("kitchen-");
		});

		it("still refuses a leading separator", () => {
			expect(typeOut(" Kitchen")).toBe("kitchen");
		});

		it("handles three words", () => {
			expect(typeOut("Bar Left Counter")).toBe("bar-left-counter");
		});

		it("does not accumulate separators when several are typed", () => {
			expect(typeOut("Bar   Left")).toBe("bar-left");
		});
	});
});
