import { describe, expect, it } from "vitest";
import { nameSchema } from "@/lib/domain/naming";
import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";
import { parseMarkup } from "@/lib/markup/parser";
import {
	ContextSource,
	hasControlCharacter,
	isControlCharacter,
	MAX_VALUE_CHARS_CEILING,
	OffsetUnit,
	VariableKind,
	variableDefinitionSchema,
	variableReferenceAt,
} from "@/lib/variables/definition";

describe("variable value sets", () => {
	it("names the three kinds", () => {
		expect(VariableKind.values).toEqual(["STATIC", "DATETIME", "CONTEXT"]);
	});

	it("names the offset units, coarsest last", () => {
		expect(OffsetUnit.values).toEqual(["MINUTES", "HOURS", "DAYS", "WEEKS", "MONTHS"]);
	});

	it("names only the context sources known before a job row exists", () => {
		// Grouped by what each describes: the printer, the machine driving it, who asked, the install.
		expect(ContextSource.values).toEqual([
			"DEVICE_NAME",
			"PAPER_COLUMNS",
			"PAPER_WIDTH",
			"CODEPAGE",
			"AGENT_NAME",
			"AGENT_HOSTNAME",
			"AGENT_PLATFORM",
			"AGENT_VERSION",
			"API_KEY_NAME",
			"IDEMPOTENCY_KEY",
			"SERVER_URL",
		]);
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

	it("refuses a non-static variable carrying a value", () => {
		const result = variableDefinitionSchema.safeParse({
			...staticVariable,
			kind: "DATETIME",
			pattern: "HH:mm",
		});
		expect(result.success).toBe(false);
	});

	it("refuses a static variable carrying a pattern, which belongs to a datetime", () => {
		expect(variableDefinitionSchema.safeParse({ ...staticVariable, pattern: "HH:mm" }).success).toBe(false);
	});

	it("accepts a value at the length ceiling", () => {
		const value = "a".repeat(MAX_VALUE_CHARS_CEILING);
		expect(variableDefinitionSchema.safeParse({ ...staticVariable, value }).success).toBe(true);
	});

	it("refuses a value one character past the length ceiling", () => {
		const value = "a".repeat(MAX_VALUE_CHARS_CEILING + 1);
		expect(variableDefinitionSchema.safeParse({ ...staticVariable, value }).success).toBe(false);
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

	it("refuses a datetime with no pattern", () => {
		const result = variableDefinitionSchema.safeParse({
			...staticVariable,
			kind: "DATETIME",
			value: null,
			pattern: null,
		});
		expect(result.success).toBe(false);
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

	it("refuses a datetime with an offset unit but no amount", () => {
		const result = variableDefinitionSchema.safeParse({
			...staticVariable,
			kind: "DATETIME",
			value: null,
			pattern: "HH:mm",
			offsetUnit: "HOURS",
		});
		expect(result.success).toBe(false);
	});

	it("accepts a datetime with a full offset", () => {
		const result = variableDefinitionSchema.safeParse({
			...staticVariable,
			kind: "DATETIME",
			value: null,
			pattern: "HH:mm",
			offsetAmount: 14,
			offsetUnit: "HOURS",
		});
		expect(result.success).toBe(true);
	});

	it("refuses a static variable carrying an offset, which only a datetime may have", () => {
		const result = variableDefinitionSchema.safeParse({
			...staticVariable,
			offsetAmount: 14,
			offsetUnit: "HOURS",
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

	it("refuses a context variable with no source", () => {
		const result = variableDefinitionSchema.safeParse({
			...staticVariable,
			kind: "CONTEXT",
			value: null,
		});
		expect(result.success).toBe(false);
	});

	it("refuses a non-context variable carrying a source", () => {
		const result = variableDefinitionSchema.safeParse({
			...staticVariable,
			source: "DEVICE_NAME",
		});
		expect(result.success).toBe(false);
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

	it("is true for a C1 character (NEL)", () => {
		expect(hasControlCharacter(String.fromCharCode(0x85))).toBe(true);
	});

	it("is true for the top of the C1 range", () => {
		expect(hasControlCharacter(String.fromCharCode(0x9f))).toBe(true);
	});

	it("is true for the last C0 character", () => {
		expect(hasControlCharacter(String.fromCharCode(0x1f))).toBe(true);
	});

	it("is false for space, the first character past the C0 cutoff", () => {
		expect(hasControlCharacter(String.fromCharCode(0x20))).toBe(false);
	});
});

describe("variableReferenceAt", () => {
	const nameIn = (source: string): string | null => {
		const match = variableReferenceAt(source, 0);
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

	/**
	 * The parser asks about the position it is standing on, so a reference further along the string
	 * is not an answer to its question. The underlying regex is sticky, which is exactly what gives
	 * this property — and what would silently break it if a caller reached the regex directly and
	 * left `lastIndex` behind, which is why the regex is not exported.
	 */
	it("matches only at the position given, not the next one along", () => {
		expect(variableReferenceAt("ab{phone}", 2)?.[1]).toBe("phone");
		expect(variableReferenceAt("ab{phone}", 0)).toBeNull();
		expect(variableReferenceAt("ab{phone}", 1)).toBeNull();
	});

	/** A stale `lastIndex` from an earlier match is the whole failure mode; two calls in a row pin it. */
	it("gives the same answer however many times it is called", () => {
		expect(variableReferenceAt("{phone}", 0)?.[1]).toBe("phone");
		expect(variableReferenceAt("{phone}", 0)?.[1]).toBe("phone");
		expect(variableReferenceAt("{time_hm}", 0)?.[1]).toBe("time_hm");
	});
});

/**
 * The two spellings of "the printer would obey this" that used to exist, pinned to each other.
 *
 * `parser.ts` refuses a control character while scanning markup; `hasControlCharacter` refuses one
 * inside a variable's value before it is substituted. They guard the same sink, and the second
 * exists only because a substituted value never passes through the first. When they were two
 * separate range expressions — `code === 0x7f || (code >= 0x80 && code <= 0x9f)` in one file,
 * `code >= 0x7f && code <= 0x9f` in the other — nothing asserted they agreed, so a byte refused
 * when an author typed it could have become reachable by putting it in a variable's value. They are
 * now one predicate, and this walks the boundaries of every range to say so.
 */
describe("the control-character rule is one rule", () => {
	/** Parsing markup made of this one character: whichever error it raises, or null if it parsed. */
	const parserVerdict = (code: number): string | null => {
		try {
			parseMarkup(`a${String.fromCharCode(code)}b`);
			return null;
		} catch (error) {
			return error instanceof MarkupError ? error.code : "other";
		}
	};

	// Every edge of C0, DEL and C1, plus the first printable character on either side of each.
	const BOUNDARIES = [0x00, 0x09, 0x1f, 0x20, 0x21, 0x7e, 0x7f, 0x80, 0x9f, 0xa0, 0xa1];

	it.each(BOUNDARIES)("agrees across the substitution boundary at U+%i", (code) => {
		const character = String.fromCharCode(code);
		const refusedWhenTyped = parserVerdict(code) === MARKUP_ERRORS.controlCharacter;

		expect(isControlCharacter(character)).toBe(refusedWhenTyped);
		expect(hasControlCharacter(`x${character}y`)).toBe(refusedWhenTyped);
	});

	it("still refuses tab, DEL and the C1 range, so this is not vacuously true", () => {
		expect(BOUNDARIES.filter((code) => isControlCharacter(String.fromCharCode(code)))).toEqual([
			0x00, 0x09, 0x1f, 0x7f, 0x80, 0x9f,
		]);
	});
});
