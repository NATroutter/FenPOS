import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MarkupError } from "@/lib/markup/errors";
import { parseDocument } from "@/lib/markup/parser";
import { TAGS } from "@/lib/markup/tags";

/** What a refusal must carry, on either side. */
interface Refusal {
	code: string;
	line: number;
	column: number;
	detail: string;
	message: string;
}

/** One markup input and what the server does with it. The agent runs the same list. */
interface ParityCase {
	name: string;
	markup: string;
	refusal: Refusal | null;
	agent?: Refusal;
}

/**
 * The cases the agent's `MarkupParityTest` also runs.
 *
 * One list read by both sides is what keeps the two parsers in step: a case cannot be added to one
 * and forgotten on the other. `agent` is the agent's own expectation where it deliberately differs,
 * and is not read here.
 */
const CASES: ParityCase[] = JSON.parse(readFileSync("../agent/src/test/resources/markup/parity-cases.json", "utf8"));

describe("markup parity cases on the server", () => {
	it("reads the shared cases", () => {
		expect(CASES.length).toBe(105);
	});

	for (const parity of CASES) {
		it(parity.name, () => {
			let thrown: unknown = null;
			try {
				parseDocument(parity.markup);
			} catch (error) {
				thrown = error;
			}

			if (parity.refusal === null) {
				expect(thrown).toBeNull();
				return;
			}
			expect(thrown).toBeInstanceOf(MarkupError);
			const error = thrown as MarkupError;
			expect({
				code: error.code,
				line: error.line,
				column: error.column,
				detail: error.detail,
				message: error.message,
			}).toEqual(parity.refusal);
		});
	}
});

/**
 * A tag's own opening occurrences in one markup string, each as the text between its name and
 * the `>` that closes it — skipping any `>` written inside a quoted value, so a case like
 * `<chart title="a > b">` is not mistaken for a shorter tag.
 */
function openTagHeaders(markup: string, tagName: string): string[] {
	const headers: string[] = [];
	const open = new RegExp(`<${tagName}(?=[\\s>])`, "gi");
	for (const match of markup.matchAll(open)) {
		const start = match.index + match[0].length;
		let end = start;
		let inQuotes = false;
		while (end < markup.length) {
			const c = markup[end];
			if (c === '"') {
				inQuotes = !inQuotes;
			} else if (c === ">" && !inQuotes) {
				break;
			}
			end++;
		}
		headers.push(markup.slice(start, end));
	}
	return headers;
}

/**
 * Mirrors the agent's `MarkupParityTest.everyTagAndAttributeIsWrittenInACase` over the server's
 * own tag registry, which reaches beyond what the agent draws: `box`, `table`, `row`, `cell`,
 * `chart`, `series`, `labels`, `bar` and `drawer` exist only here, and only this side can force
 * their attributes into a case at all.
 *
 * The search is scoped to each tag's own occurrence rather than the whole fixture, the way the
 * agent's is: an attribute is covered only when it is written on the tag that declares it, not
 * merely somewhere in the corpus under the same name.
 */
describe("every server tag and attribute is written in a case", () => {
	it("covers each tag name and each attribute on its own tag", () => {
		const missing: string[] = [];
		for (const tag of Object.values(TAGS)) {
			const occurrences = CASES.flatMap((parity) => openTagHeaders(parity.markup, tag.name));
			if (occurrences.length === 0) {
				missing.push(`<${tag.name}>`);
			}
			for (const attribute of Object.keys(tag.attributes)) {
				const attributePattern = new RegExp(`(^|[^a-zA-Z0-9_-])${attribute}=`, "i");
				if (!occurrences.some((header) => attributePattern.test(header))) {
					missing.push(`<${tag.name}> ${attribute}`);
				}
			}
		}
		expect(missing).toEqual([]);
	});
});
