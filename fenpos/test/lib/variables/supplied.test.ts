import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/errors";
import { readSuppliedVariables } from "@/lib/variables/supplied";

describe("readSuppliedVariables", () => {
	const read = (value: unknown, cap = 200) => readSuppliedVariables(value, cap);

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
		expect(read({ order_id: "1041", customer: "Matti" })).toEqual({ order_id: "1041", customer: "Matti" });
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

	it("refuses a non-string value", () => {
		expect(codeOf({ order_id: 1041 })).toBe("invalid_type");
	});

	it("refuses a value past the cap", () => {
		expect(codeOf({ note: "x".repeat(201) })).toBe("variable_too_long");
	});

	it("accepts a value exactly at the cap", () => {
		expect(read({ note: "x".repeat(200) })).toEqual({ note: "x".repeat(200) });
	});

	it("refuses a value carrying a control character", () => {
		expect(codeOf({ note: `a${String.fromCharCode(0x1b)}b` })).toBe("invalid_variable_value");
	});

	it("accepts an empty value, which is a real thing to send", () => {
		expect(read({ note: "" })).toEqual({ note: "" });
	});
});
