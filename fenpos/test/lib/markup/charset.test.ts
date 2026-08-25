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

	// -----------------------------------------------------------------------
	// Characters that arrived by substitution
	// -----------------------------------------------------------------------

	/**
	 * A value is arbitrary text from a database row, so it is exactly the text most likely to hold a
	 * character the shop's printer cannot represent — and the least likely for the caller to be able
	 * to find, since it does not appear in the element they wrote at all.
	 */
	describe("a character that came from a variable", () => {
		const substituted = (markup: string, value: string): UnsupportedCharacterError => {
			const line = parseMarkup(markup, { values: new Map([["x", value]]), maxPerElement: 10 });
			try {
				validateCharset(line, "CP437", "REJECT");
			} catch (thrown) {
				if (thrown instanceof UnsupportedCharacterError) {
					return thrown;
				}
				throw thrown;
			}
			throw new Error(`expected '${markup}' with value '${value}' to be rejected`);
		};

		/**
		 * The column names the reference, not a position counted through the value's own characters.
		 *
		 * `{x}` occupies three columns; `Kahvi €` is seven characters, and the euro is the seventh of
		 * them. Counting forward reported column 7 of a three-column element — a position that does
		 * not exist, in the field a client uses to underline the mistake for its user.
		 */
		it("reports the reference's column rather than one past the end of the element", () => {
			const thrown = substituted("{x}", "Kahvi €");

			expect(thrown.character).toBe("€");
			expect(thrown.column).toBe(1);
		});

		it("names the variable, since the column can no longer say where inside the value", () => {
			expect(substituted("ab{x}", "€").variable).toBe("x");
		});

		it("leaves the variable null for a character the caller actually typed", () => {
			expect(rejection("€10", "CP437").variable).toBeNull();
		});

		/** The reference's own column is still exact, which is what makes the answer useful at all. */
		it("points at the brace, wherever in the element it was written", () => {
			expect(substituted("<bold>ab</bold>{x}", "€").column).toBe(16);
		});
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

	/**
	 * The boundary `survivors` is one entry longer for: a fill after the *last* span, whose only
	 * preceding span was dropped. Every other case here puts the fill between two spans, so without
	 * this one the final `survivors.push` can be deleted and the suite stays green — while a
	 * trailing fill reads past the end of the array and takes `undefined` as its index.
	 */
	it("moves a trailing fill past a dropped span", () => {
		const line = validate("š<fill>", "CP437", "STRIP");

		expect(line.spans).toEqual([]);
		expect(line.fills[0].afterSpans).toBe(0);
	});

	/**
	 * The spec's other half: "the remaining fills absorb its slack" needs a fill still standing to
	 * absorb it, so every test above — one fill each — leaves it unpinned. Only the character is
	 * unprintable here; no span is dropped, so `afterSpans` is untouched and the surviving fill's
	 * position is the thing this checks.
	 */
	it("keeps the surviving fill when the strip policy drops its neighbour", () => {
		const line = validate("a<fill=€>b<fill=.>c", "CP437", "STRIP");

		expect(line.spans.map((span) => span.text)).toEqual(["a", "b", "c"]);
		expect(line.fills).toHaveLength(1);
		expect(line.fills[0].character).toBe(".");
		expect(line.fills[0].afterSpans).toBe(2);
	});
});
