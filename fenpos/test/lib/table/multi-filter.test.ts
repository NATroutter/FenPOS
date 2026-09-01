import { describe, expect, it } from "vitest";
import { anyOf, joinValues, parseKnownValues, parseValues } from "@/lib/table/multi-filter";

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
