import { describe, expect, it } from "vitest";
import { anyOf, joinValues, parseKnownValues, parseOffset, parseValues } from "@/lib/table/multi-filter";

/**
 * The two halves have to agree, which is why they live in one module and are tested against each
 * other here rather than separately: a separator chosen in one place and assumed in another is how a
 * filter comes to work everywhere except the column nobody checked.
 */
describe("parseValues", () => {
	it("reads one value", () => {
		expect(parseValues("FAILED")).toEqual(["FAILED"]);
	});

	it("reads several", () => {
		expect(parseValues("FAILED,CANCELLED")).toEqual(["FAILED", "CANCELLED"]);
	});

	it("reads an absent parameter as no filter", () => {
		expect(parseValues(undefined)).toEqual([]);
		expect(parseValues("")).toEqual([]);
	});

	it("drops empty values a stray separator leaves behind", () => {
		expect(parseValues("FAILED,,CANCELLED,")).toEqual(["FAILED", "CANCELLED"]);
	});
});

describe("parseKnownValues", () => {
	const known = (candidate: string): candidate is "a" | "b" => candidate === "a" || candidate === "b";

	it("keeps what this version recognises and drops the rest", () => {
		// A bookmark saved before a value was renamed should still list rows, rather than putting a
		// value in the trigger that the dropdown has no label for.
		expect(parseKnownValues("a,gone,b", known)).toEqual(["a", "b"]);
	});

	it("reads a parameter of nothing but unknowns as no filter", () => {
		expect(parseKnownValues("gone,also-gone", known)).toEqual([]);
	});
});

describe("joinValues", () => {
	it("round-trips through parseValues", () => {
		const values = ["FAILED", "CANCELLED"];
		expect(parseValues(joinValues(values) ?? undefined)).toEqual(values);
	});

	it("gives null for nothing, so the caller drops the parameter rather than writing an empty one", () => {
		expect(joinValues([])).toBeNull();
	});
});

describe("anyOf", () => {
	it("gives equals for one value, which is the query these columns already had", () => {
		expect(anyOf("FAILED")).toEqual({ equals: "FAILED" });
		expect(anyOf(["FAILED"])).toEqual({ equals: "FAILED" });
	});

	it("gives in for several", () => {
		expect(anyOf(["FAILED", "CANCELLED"])).toEqual({ in: ["FAILED", "CANCELLED"] });
	});

	it("narrows by numbers as well as strings, for the stored severity", () => {
		expect(anyOf([30, 40])).toEqual({ in: [30, 40] });
	});

	it("gives undefined for everything that is not a filter", () => {
		// "The operator picked nothing" means every row, not no rows — unticking the last option in a
		// dropdown puts the table back rather than emptying it.
		expect(anyOf(undefined)).toBeUndefined();
		expect(anyOf([])).toBeUndefined();
		expect(anyOf("")).toBeUndefined();
		expect(anyOf(["", ""])).toBeUndefined();
	});
});

/**
 * Every infinite-scroll action's own `skip`, read off the wire the same way.
 *
 * The lower bound is the one `archives/actions.ts`'s `pageOf` already needed for the same reason — a
 * server action's argument is whatever was posted to it. The upper bound is this module's own: those
 * three actions read a live table rather than one decompressed period at a time, so nothing else stops
 * a caller who holds the read permission from asking for an offset a real scroll would never reach.
 */
describe("parseOffset", () => {
	it("passes a normal offset through unchanged", () => {
		expect(parseOffset(50)).toBe(50);
	});

	it("truncates a fractional offset rather than handing SQLite a fraction", () => {
		expect(parseOffset(12.7)).toBe(12);
	});

	it("clamps a negative offset to zero", () => {
		expect(parseOffset(-5)).toBe(0);
	});

	it("clamps whatever is not a usable number to zero", () => {
		expect(parseOffset(Number.NaN)).toBe(0);
		expect(parseOffset("not a number")).toBe(0);
		expect(parseOffset({ not: "a number" })).toBe(0);
		expect(parseOffset(undefined)).toBe(0);
	});

	it("clamps an offset larger than any real scroll would reach", () => {
		// Goes red if the upper bound is dropped: a caller holding the read permission could otherwise
		// force `OFFSET 4000000000` against a live table on every call.
		expect(parseOffset(4_000_000_000)).toBe(1_000_000);
	});

	it("leaves an offset just under the cap alone", () => {
		// The teeth on the case above: without it, a mutation that always returned the cap would pass.
		expect(parseOffset(999_999)).toBe(999_999);
	});
});
