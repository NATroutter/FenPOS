import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MarkupError } from "@/lib/markup/errors";
import { parseDocument } from "@/lib/markup/parser";

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
		expect(CASES.length).toBe(94);
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
