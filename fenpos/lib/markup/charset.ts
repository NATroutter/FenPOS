import iconv from "iconv-lite";
import type { Codepage, UnsupportedPolicy } from "@/lib/domain/enums";
import { UnsupportedCharacterError } from "@/lib/markup/errors";
import { columnAt, type Line, type Span } from "@/lib/markup/model";

/**
 * Checks that every character of a line can be represented in the device's codepage.
 *
 * A printer interprets each byte through one single-byte table, so Unicode text has to be
 * narrowed to that table before it can be sent. This runs before any text reaches the agent,
 * because the renderer there encodes with a library that silently substitutes `?` and cannot
 * report which character was lost. Checking here is what makes an exact `unsupported_character`
 * error — naming the character, its column and the codepage — possible at all.
 *
 * Ported from `CharsetValidator.java`. The Java version asked a `CharsetEncoder`; there is no
 * equivalent for DOS codepages in Node, so the repertoire is derived instead, which is both
 * exact and faster than encoding character by character.
 */

/** Stand-in emitted by the `REPLACE` policy. */
const REPLACEMENT = "?";

/**
 * Maps this system's codepage names onto iconv-lite's.
 *
 * Kept as an explicit table rather than derived from the name, because the two vocabularies
 * agree by coincidence rather than by rule — and a silently mismatched table would validate
 * against the wrong repertoire, which is worse than failing to find one.
 */
const ICONV_NAMES: Record<Codepage, string> = {
	CP437: "cp437",
	CP850: "cp850",
	CP852: "cp852",
	CP857: "cp857",
	CP858: "cp858",
	CP860: "cp860",
	CP863: "cp863",
	CP865: "cp865",
	CP866: "cp866",
	CP1250: "win1250",
	CP1251: "win1251",
	CP1252: "win1252",
	ISO8859_7: "iso88597",
};

/** Every character each codepage can represent, built once per codepage on first use. */
const repertoires = new Map<Codepage, Set<string>>();

/**
 * Returns the set of characters a codepage can print.
 *
 * Derived by decoding all 256 byte values through the table, which is exactly the definition of
 * what it can represent. Doing it once and caching turns per-character validation into a set
 * lookup, which matters because this runs over every character of every job.
 *
 * @param codepage the table the printer will be switched to
 * @returns the characters it can represent
 */
function repertoireOf(codepage: Codepage): Set<string> {
	const cached = repertoires.get(codepage);
	if (cached) {
		return cached;
	}

	const encoding = ICONV_NAMES[codepage];
	const characters = new Set<string>();
	for (let byte = 0; byte <= 0xff; byte++) {
		const decoded = iconv.decode(Buffer.from([byte]), encoding);
		// A byte with no assignment decodes to the replacement character; including it would
		// declare U+FFFD printable, which it is not.
		if (decoded.length > 0 && decoded !== "�") {
			characters.add(decoded);
		}
	}

	repertoires.set(codepage, characters);
	return characters;
}

/**
 * Whether a codepage can represent a character.
 *
 * @param character a single character, which may be a surrogate pair
 * @param codepage the table to check against
 * @returns true when the printer can print it
 */
export function canEncode(character: string, codepage: Codepage): boolean {
	return repertoireOf(codepage).has(character);
}

/**
 * Applies the device's unsupported-character policy to a line.
 *
 * @param line the parsed line
 * @param codepage the table the printer will be switched to
 * @param policy what to do with a character the table cannot represent
 * @returns the line, with substitutions applied when the policy is not to reject
 * @throws UnsupportedCharacterError if the policy is to reject and a character cannot be
 *         represented
 */
export function validateCharset(line: Line, codepage: Codepage, policy: UnsupportedPolicy): Line {
	const converted: Span[] = [];

	for (const span of line.spans) {
		const text = convert(span, codepage, policy);
		// A span stripped down to nothing is dropped rather than kept as an empty run, so later
		// stages never have to reason about zero-width spans.
		if (text.length > 0) {
			converted.push({ ...span, text });
		}
	}

	return { align: line.align, wrap: line.wrap, spans: converted, directives: line.directives };
}

/**
 * Applies the policy to one span's text.
 *
 * @returns the resulting text, which is the original string when nothing changed
 * @throws UnsupportedCharacterError under the `REJECT` policy
 */
function convert(span: Span, codepage: Codepage, policy: UnsupportedPolicy): string {
	const repertoire = repertoireOf(codepage);
	const text = span.text;

	// Left null until the first unrepresentable character, so text that needs no conversion —
	// the overwhelmingly common case — builds nothing.
	let rewritten: string | null = null;

	let offset = 0;
	while (offset < text.length) {
		const codePoint = text.codePointAt(offset) ?? 0;
		const width = codePoint > 0xffff ? 2 : 1;
		const character = text.slice(offset, offset + width);

		if (repertoire.has(character)) {
			if (rewritten !== null) {
				rewritten += character;
			}
		} else {
			if (policy === "REJECT") {
				throw new UnsupportedCharacterError(character, columnAt(span, offset), codepage);
			}
			if (rewritten === null) {
				rewritten = text.slice(0, offset);
			}
			if (policy === "REPLACE") {
				rewritten += REPLACEMENT;
			}
		}
		offset += width;
	}

	return rewritten === null ? text : rewritten;
}
