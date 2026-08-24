import { describe, expect, it } from "vitest";
import { nameSchema } from "@/lib/domain/naming";
import {
	ContextSource,
	hasControlCharacter,
	OffsetUnit,
	VARIABLE_REFERENCE,
	VariableKind,
	variableDefinitionSchema,
} from "@/lib/variables/definition";

describe("variable value sets", () => {
	it("names the three kinds", () => {
		expect(VariableKind.values).toEqual(["STATIC", "DATETIME", "CONTEXT"]);
	});

	it("names the offset units, coarsest last", () => {
		expect(OffsetUnit.values).toEqual(["MINUTES", "HOURS", "DAYS", "WEEKS", "MONTHS"]);
	});

	it("names only the context sources known before a job row exists", () => {
		expect(ContextSource.values).toEqual(["DEVICE_NAME", "AGENT_NAME", "API_KEY_NAME"]);
	});

	it("does not admit JOB_ID, which is deferred", () => {
		expect(ContextSource.is("JOB_ID")).toBe(false);
	});
});

describe("variableDefinitionSchema", () => {
	const staticVariable = {
		name: "phone",
		kind: "STATIC" as const,
		value: "010-1234567",
		pattern: null,
		offsetAmount: null,
		offsetUnit: null,
		source: null,
		overridable: false,
		description: null,
	};

	it("accepts a static variable", () => {
		expect(variableDefinitionSchema.safeParse(staticVariable).success).toBe(true);
	});

	it("refuses a static variable with no value", () => {
		expect(variableDefinitionSchema.safeParse({ ...staticVariable, value: null }).success).toBe(false);
	});

	it("refuses a static variable carrying a pattern, which belongs to a datetime", () => {
		expect(variableDefinitionSchema.safeParse({ ...staticVariable, pattern: "HH:mm" }).success).toBe(false);
	});

	it("refuses a value containing a control character", () => {
		const escape = String.fromCharCode(0x1b);
		expect(variableDefinitionSchema.safeParse({ ...staticVariable, value: `a${escape}b` }).success).toBe(false);
	});

	it("accepts a datetime with a pattern and no offset", () => {
		const result = variableDefinitionSchema.safeParse({
			...staticVariable,
			kind: "DATETIME",
			value: null,
			pattern: "HH:mm",
		});
		expect(result.success).toBe(true);
	});

	it("refuses a datetime with an offset amount but no unit", () => {
		const result = variableDefinitionSchema.safeParse({
			...staticVariable,
			kind: "DATETIME",
			value: null,
			pattern: "HH:mm",
			offsetAmount: 14,
		});
		expect(result.success).toBe(false);
	});

	it("accepts a context variable naming a source", () => {
		const result = variableDefinitionSchema.safeParse({
			...staticVariable,
			kind: "CONTEXT",
			value: null,
			source: "DEVICE_NAME",
		});
		expect(result.success).toBe(true);
	});

	it("refuses a name that is not slug-shaped", () => {
		expect(variableDefinitionSchema.safeParse({ ...staticVariable, name: "My Phone" }).success).toBe(false);
	});
});

describe("hasControlCharacter", () => {
	it("is false for ordinary receipt text", () => {
		expect(hasControlCharacter("Fish & Chips — 12,50 €")).toBe(false);
	});

	it("is true for an escape", () => {
		expect(hasControlCharacter(`ab${String.fromCharCode(0x1b)}c`)).toBe(true);
	});

	it("is true for a newline, which would desynchronise the line model", () => {
		expect(hasControlCharacter("a\nb")).toBe(true);
	});

	it("is true for DEL", () => {
		expect(hasControlCharacter(String.fromCharCode(0x7f))).toBe(true);
	});
});

describe("VARIABLE_REFERENCE", () => {
	const nameIn = (source: string): string | null => {
		const match = VARIABLE_REFERENCE.exec(source);
		return match ? match[1] : null;
	};

	it("matches a slug-shaped name at the start", () => {
		expect(nameIn("{phone} rest")).toBe("phone");
	});

	it("matches dashes and underscores after the first character", () => {
		expect(nameIn("{time_hm}")).toBe("time_hm");
		expect(nameIn("{return-by}")).toBe("return-by");
	});

	it("does not match text with a space in it", () => {
		expect(nameIn("{1 of 4}")).toBeNull();
	});

	it("does not match an unclosed brace", () => {
		expect(nameIn("{phone")).toBeNull();
	});

	it("does not match a leading dash", () => {
		expect(nameIn("{-phone}")).toBeNull();
	});

	it("agrees with nameSchema on every name it matches", () => {
		for (const candidate of ["a", "phone", "time_hm", "return-by", "x9", "a".repeat(64)]) {
			expect(nameIn(`{${candidate}}`)).toBe(candidate);
			expect(nameSchema.safeParse(candidate).success).toBe(true);
		}
	});

	it("stops at nameSchema's length ceiling rather than matching forever", () => {
		expect(nameIn(`{${"a".repeat(65)}}`)).toBeNull();
	});
});
