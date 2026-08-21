import { describe, expect, it } from "vitest";
import type { Codepage, UnsupportedPolicy } from "@/lib/domain/enums";
import { validateCharset } from "@/lib/markup/charset";
import { UnsupportedCharacterError } from "@/lib/markup/errors";
import type { Line } from "@/lib/markup/model";
import { parseMarkup } from "@/lib/markup/parser";

/**
 * Behavioural tests for the codepage check.
 *
 * Translated case for case from `CharsetValidatorTest.java`. The codepage cases are chosen from
 * the real difference between the tables: CP437 carries the Nordic vowels but not the euro sign,
 * CP858 carries both. That difference is the whole reason the setting exists.
 */
describe("validateCharset", () => {
	const plainText = (line: Line): string => line.spans.map((span) => span.text).join("");

	const validate = (markup: string, codepage: Codepage, policy: UnsupportedPolicy): Line =>
		validateCharset(parseMarkup(markup), codepage, policy);

	/** Validates and returns the error, failing the test if it was accepted. */
	const rejection = (markup: string, codepage: Codepage): UnsupportedCharacterError => {
		try {
			validate(markup, codepage, "REJECT");
		} catch (thrown) {
			if (thrown instanceof UnsupportedCharacterError) {
				return thrown;
			}
			throw thrown;
		}
		throw new Error(`expected '${markup}' to be rejected on ${codepage}`);
	};

	it("accepts text fully representable in the codepage", () => {
		expect(plainText(validate("Hyvaa paivaa", "CP437", "REJECT"))).toBe("Hyvaa paivaa");
	});

	it("accepts Nordic vowels on CP437", () => {
		expect(plainText(validate("Hyvää päivää", "CP437", "REJECT"))).toBe("Hyvää päivää");
	});

	it("rejects the euro sign on CP437", () => {
		const thrown = rejection("€10", "CP437");

		expect(thrown.character).toBe("€");
		expect(thrown.column).toBe(1);
		expect(thrown.codepage).toBe("CP437");
	});

	it("accepts the euro sign on CP858", () => {
		expect(plainText(validate("€10", "CP858", "REJECT"))).toBe("€10");
	});

	it("reports an astral character as one whole character", () => {
		// An emoji is two UTF-16 code units. Reporting half a surrogate pair would render as a
		// broken box in the client's error message and identify nothing.
		const thrown = rejection("Hello 😎", "CP858");

		expect(thrown.character).toBe("😎");
		expect(thrown.character.length).toBe(2);
		expect(thrown.column).toBe(7);
	});

	it("reports the column relative to the original element, markup included", () => {
		expect(rejection("<bold>ab</bold>€", "CP437").column).toBe(16);
	});

	it("substitutes a question mark under REPLACE", () => {
		expect(plainText(validate("€10", "CP437", "REPLACE"))).toBe("?10");
	});

	it("removes the character under STRIP", () => {
		expect(plainText(validate("€10", "CP437", "STRIP"))).toBe("10");
	});

	it("drops a span that STRIP empties", () => {
		const line = validate("<bold>€</bold>ok", "CP437", "STRIP");

		expect(line.spans).toHaveLength(1);
		expect(plainText(line)).toBe("ok");
	});

	it("preserves styling and directives", () => {
		const line = validate("<bold>ok</bold><feed=2>", "CP858", "REJECT");

		expect(line.spans[0].style.bold).toBe(true);
		expect(line.directives).toHaveLength(1);
	});

	// -----------------------------------------------------------------------
	// Fills
	// -----------------------------------------------------------------------

	/**
	 * The euro is the right character to test this with and a middle dot is the wrong one: CP437
	 * holds U+00B7 at 0xFA, so `<fill=·>` prints there perfectly well.
	 */
	it("rejects a fill character the codepage cannot represent", () => {
		expect(rejection("a<fill=€>b", "CP437").character).toBe("€");
	});

	it("reports the fill's own column when it rejects one", () => {
		expect(rejection("a<fill=€>b", "CP437").column).toBe(2);
	});

	it("substitutes a fill character under the replace policy", () => {
		expect(validate("a<fill=€>b", "CP437", "REPLACE").fills[0].character).toBe("?");
	});

	/**
	 * A fill whose character cannot be printed at all is dropped, matching a span stripped to
	 * nothing. What slack it would have taken goes to whatever fills remain.
	 */
	it("drops a fill whose character the strip policy removes", () => {
		expect(validate("a<fill=€>b", "CP437", "STRIP").fills).toEqual([]);
	});

	it("leaves a printable fill character alone", () => {
		expect(validate("a<fill=.>b", "CP437", "REJECT").fills[0].character).toBe(".");
	});

	/**
	 * `afterSpans` indexes a list this pass rewrites. `š` is absent from CP437, so stripping it
	 * removes the span the fill was recorded against, and without the repair the pad would land on
	 * the wrong side of what is left.
	 */
	it("moves a fill past a span the strip policy removed", () => {
		const line = validate("š<fill>b", "CP437", "STRIP");

		expect(line.spans.map((span) => span.text)).toEqual(["b"]);
		expect(line.fills[0].afterSpans).toBe(0);
	});

	it("leaves a fill's index alone when nothing is dropped", () => {
		expect(validate("a<fill>b", "CP437", "STRIP").fills[0].afterSpans).toBe(1);
	});
});
