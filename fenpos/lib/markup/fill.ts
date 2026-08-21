import { type Fill, type Line, lineColumns, type Span } from "@/lib/markup/model";

/**
 * Expands `<fill>` into the characters it stands for, once the paper's width is known.
 *
 * **This is the whole reason the tag exists.** Alignment on a thermal printer is `ESC a n`, which
 * justifies a whole line buffer, so two justifications on one line have no rendering — which is why
 * `<align>` must own its line and why a label-left, amount-right row cannot be written with it.
 * Such a row is column layout, column layout on this hardware is padding, and padding needs a
 * column count that belongs to the device. This is the first stage that holds one.
 *
 * Ported to `FillResolver.java`; the two carry the same tests with the same literal expectations.
 */

/**
 * Replaces every fill on a line with the span it stands for.
 *
 * @param line a parsed line, after the charset pass has settled its characters
 * @param columns the device's printable columns at normal character width
 * @returns the line with its fills expanded and `fills` emptied; the same object when it had none
 */
export function resolveFills(line: Line, columns: number): Line {
	if (line.fills.length === 0) {
		return line;
	}

	const budgets = share(Math.max(0, columns - lineColumns(line)), line.fills.length);
	const spans: Span[] = [];
	let next = 0;

	for (let index = 0; index < line.fills.length; index++) {
		const fill = line.fills[index];
		// Fills are recorded in source order and `afterSpans` never decreases, so the untouched
		// spans before each one can be taken as a slice rather than searched for.
		spans.push(...line.spans.slice(next, fill.afterSpans));
		next = fill.afterSpans;

		const pad = padFor(fill, budgets[index]);
		if (pad) {
			spans.push(pad);
		}
	}
	spans.push(...line.spans.slice(next));

	return { align: line.align, wrap: line.wrap, spans, fills: [], directives: line.directives };
}

/**
 * Splits the slack between the fills that share it.
 *
 * The remainder goes to the earliest gaps. Which gap takes it changes nothing about where the line
 * ends — the total handed out is the slack either way, so the rightmost text is flush to the edge
 * regardless — so the rule exists to be deterministic rather than to be right.
 *
 * No special case is needed for more fills than columns: `base` is then zero and the first `slack`
 * fills take one column each, which is what an evenly split remainder means.
 *
 * @param slack columns left over after the line's text
 * @param count how many fills are sharing them
 * @returns one budget per fill, in order, summing to `slack`
 */
function share(slack: number, count: number): number[] {
	const base = Math.floor(slack / count);
	const remainder = slack % count;
	return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

/**
 * Builds one fill's span, or null when its budget buys nothing.
 *
 * The budget is spent in whole characters, so a fill written inside `<size=N>` can leave up to
 * `N - 1` columns unspent and the line lands that much short of the paper's edge. Under the default
 * multiplier of one — every ordinary receipt row — that cannot happen. Chasing the missing column
 * would mean machinery that only ever runs for a pad inside an enlarged span.
 *
 * @param fill the fill to expand
 * @param budget the columns it was given
 * @returns the span to insert, or null when there is no room for even one character
 */
function padFor(fill: Fill, budget: number): Span | null {
	const count = Math.floor(budget / fill.style.widthMult);
	if (count <= 0) {
		return null;
	}
	return { text: fill.character.repeat(count), style: fill.style, sourceColumn: fill.sourceColumn };
}
