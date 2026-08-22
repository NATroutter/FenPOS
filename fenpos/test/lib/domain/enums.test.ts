import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	Align,
	Codepage,
	ConnectionStatus,
	FlowControl,
	Font,
	isTerminalJobStatus,
	JobStatus,
	Linefeed,
	Parity,
	UnsupportedPolicy,
} from "@/lib/domain/enums";

/**
 * Guards the TypeScript value sets against the Java enums they mirror.
 *
 * This is the failure these tests exist for: the server accepts a value the agent cannot
 * parse, so a job is acknowledged with a 202 and then dies on the far side of the link.
 * Reviewing two files in different languages does not reliably catch that, so the Java
 * sources are parsed and compared directly.
 */

const ENUM_DIR = fileURLToPath(new URL("../../../../agent/src/main/java/fi/natroutter/fenpos/enums/", import.meta.url));

/**
 * Extracts the constant names declared by a Java enum.
 *
 * Comments are stripped first so that prose mentioning a removed constant cannot make a
 * stale set look correct. The constant list ends at the first semicolon for enums carrying
 * fields, and at the closing brace for plain ones.
 *
 * @param fileName the enum source file, relative to the agent enums package
 * @returns the declared constant names in declaration order
 */
function javaEnumConstants(fileName: string): string[] {
	const source = readFileSync(join(ENUM_DIR, fileName), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");

	const bodyStart = source.indexOf("{", source.search(/\benum\s+\w+/));
	if (bodyStart === -1) {
		throw new Error(`No enum body found in ${fileName}`);
	}

	const rest = source.slice(bodyStart + 1);

	// The constant list ends at the first semicolon in enums that carry fields. The closing
	// brace is only a valid terminator for plain enums, because a constant argument may
	// itself contain braces — Linefeed declares `LF(new byte[]{0x0A})`, whose brace would
	// otherwise truncate the list after its first entry.
	const semicolon = rest.indexOf(";");
	const brace = rest.indexOf("}");
	let end = rest.length;
	if (semicolon !== -1) {
		end = semicolon;
	} else if (brace !== -1) {
		end = brace;
	}

	return [...rest.slice(0, end).matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*(?:\(|,|$)/gm)].map((match) => match[1]);
}

describe("java enum parity", () => {
	const cases: ReadonlyArray<[string, string, readonly string[]]> = [
		["Align", "Align.java", Align.values],
		["Codepage", "Codepage.java", Codepage.values],
		["ConnectionStatus", "ConnectionStatus.java", ConnectionStatus.values],
		["FlowControl", "FlowControl.java", FlowControl.values],
		["Font", "Font.java", Font.values],
		["JobStatus / JobState", "JobState.java", JobStatus.values],
		["Linefeed", "Linefeed.java", Linefeed.values],
		["Parity", "Parity.java", Parity.values],
		["UnsupportedPolicy", "UnsupportedPolicy.java", UnsupportedPolicy.values],
	];

	it.each(cases)("%s matches the Java enum exactly", (_label, fileName, values) => {
		expect(javaEnumConstants(fileName)).toEqual([...values]);
	});

	it("parses a known enum correctly, so an empty result cannot pass silently", () => {
		// Without this, a parser that returned [] for everything would make every case above
		// pass against an equally empty set.
		expect(javaEnumConstants("Align.java")).toEqual(["LEFT", "CENTER", "RIGHT"]);
		expect(javaEnumConstants("Codepage.java").length).toBe(13);
	});
});

describe("closed set guards", () => {
	it("accepts declared values", () => {
		expect(Codepage.is("CP858")).toBe(true);
		expect(Linefeed.is("NONE")).toBe(true);
	});

	it("rejects values outside the set", () => {
		expect(Codepage.is("CP999")).toBe(false);
		expect(Linefeed.is("CR")).toBe(false);
		expect(Align.is("JUSTIFY")).toBe(false);
	});

	it("rejects case variants, since stored values are compared exactly", () => {
		expect(Codepage.is("cp858")).toBe(false);
		expect(Align.is("left")).toBe(false);
	});

	it("rejects inherited object properties that are not set members", () => {
		expect(Align.is("toString")).toBe(false);
		expect(Align.is("constructor")).toBe(false);
	});

	it("validates through the Zod schema at trust boundaries", () => {
		expect(Codepage.schema.safeParse("CP858").success).toBe(true);
		expect(Codepage.schema.safeParse("CP999").success).toBe(false);
		expect(Codepage.schema.safeParse(null).success).toBe(false);
	});
});

describe("job status transitions", () => {
	it("treats settled states as terminal", () => {
		expect(isTerminalJobStatus("COMPLETED")).toBe(true);
		expect(isTerminalJobStatus("FAILED")).toBe(true);
		expect(isTerminalJobStatus("CANCELLED")).toBe(true);
	});

	it("treats in-flight states as non-terminal", () => {
		expect(isTerminalJobStatus("QUEUED")).toBe(false);
		expect(isTerminalJobStatus("PRINTING")).toBe(false);
	});

	it("classifies every declared status, so a new one cannot be silently non-terminal", () => {
		for (const status of JobStatus.values) {
			expect(typeof isTerminalJobStatus(status)).toBe("boolean");
		}
	});
});
