import type { ItemNode, ListNode, ListStyle, Node } from "@/lib/markup/document";

/**
 * Turns a list into the printed lines it stands for.
 *
 * **A list is expanded, not drawn.** A dash, a number and a letter are characters every codepage a
 * thermal printer supports already has, so an entry's marker is text the device prints for itself and
 * the line stays native. Only `style=check` costs a raster, and it costs one because a hollow square
 * is not in any of those codepages — the same reason `<check>` exists at all.
 *
 * Two things here are properties of the whole list rather than of one entry, which is why this reads
 * a `<list>` instead of each `<item>` as it closes. The marker column is as wide as the widest marker
 * the list will print, so `9.` and `10.` put their text in the same column. And the hanging indent
 * every line carries is that column's width, so a wrapped entry continues under its own text rather
 * than under its marker.
 */

/**
 * Columns a drawn checkbox and the space after it are counted as.
 *
 * A count of columns for something measured in dots, and therefore approximate: the box and its gaps
 * come to 21 dots and the space after it to 12, against the 36 three columns stand for. The three
 * dots of slack are a quarter of a character and only ever show as a nested list under a `check` list
 * sitting a hair left of its parent's text. Exact would mean a marker width that depends on the
 * device's font metrics, which is a property of the paper rather than of the list.
 */
const CHECK_MARKER_COLUMNS = 3;

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** One printed line of a list, ready to be flattened or drawn like any other. */
export interface LineDraft {
	/** The source line the entry was written on, which a refusal about this printed line names. */
	line: number;
	nodes: Node[];
	/** Columns a wrapped continuation of this line begins at, which is where the entry's text begins. */
	indent: number;
}

/** A run of content on a line of its own, or a list nested beneath the entry. */
type Part = { kind: "text"; line: number; nodes: Node[] } | { kind: "list"; list: ListNode };

/** One entry, cut into the line it prints itself and everything that follows that line. */
interface Entry {
	own: Node[];
	rest: Part[];
}

/**
 * Expands a list into its printed lines, innermost lists included.
 *
 * @param list the list
 * @param indent columns the whole list is set in from the left, which is what nests it
 * @returns one draft per printed line, in printing order
 */
export function expandList(list: ListNode, indent: number): LineDraft[] {
	const items = list.children.filter((child): child is ItemNode => child.kind === "item");
	// Null for a `check` list, whose marker is drawn rather than written.
	const bodies = list.style === "check" ? null : items.map((_, index) => markerBody(list.style, list.start + index));
	const width = bodies === null ? CHECK_MARKER_COLUMNS : widest(bodies) + 1;
	const hanging = indent + width;

	const drafts: LineDraft[] = [];
	for (const [index, item] of items.entries()) {
		const entry = split(item.children);
		// The entry's own line always comes first, marker and all, even when it holds nothing but a
		// nested list: an entry whose marker never printed is an entry the reader cannot count.
		drafts.push({
			line: item.line,
			nodes: [...marker(item, bodies === null ? null : bodies[index], indent, width), ...entry.own],
			indent: hanging,
		});

		for (const part of entry.rest) {
			if (part.kind === "list") {
				drafts.push(...expandList(part.list, hanging));
			} else {
				drafts.push({ line: part.line, nodes: [spaces(hanging, item), ...part.nodes], indent: hanging });
			}
		}
	}

	return drafts;
}

/**
 * Splits one entry's children at the lists nested in it.
 *
 * Breaks are dropped and whitespace-only runs at each end of a part go with them: an entry is one
 * printed line however many source lines the author laid it out over, and the indentation that makes
 * a nested list readable is markup rather than paper.
 *
 * What came before the first nested list is the entry's own line, which may hold nothing at all —
 * an entry written as a heading over a sub-list still prints its marker.
 *
 * @param children one item's children
 * @returns the entry's own content, and every part that prints on a line below it
 */
function split(children: Node[]): Entry {
	const parts: Part[] = [];
	let run: Node[] = [];
	let line = 0;

	const close = (): void => {
		const trimmed = trim(run);
		if (trimmed.length > 0) {
			parts.push({ kind: "text", line, nodes: trimmed });
		}
		run = [];
	};

	for (const child of children) {
		if (child.kind === "break") {
			continue;
		}
		if (child.kind === "list") {
			close();
			parts.push({ kind: "list", list: child });
			continue;
		}
		if (run.length === 0) {
			line = child.line;
		}
		run.push(child);
	}
	close();

	const first = parts[0];
	return first?.kind === "text" ? { own: first.nodes, rest: parts.slice(1) } : { own: [], rest: parts };
}

/**
 * Drops the whitespace at either end of one part.
 *
 * **A list is the one place the author's own indentation is taken away from them.** Elsewhere the
 * language keeps it: a line of text inside a `<box>` prints every space it was written with, because
 * where that text sits is the author's business. A list's columns are not — the marker column's width
 * comes from counting the entries and the indent from how deep the list nests — so a space the author
 * typed in front of an entry's text would move it out of a column the list computed and nobody chose.
 *
 * The column travels with the trim, so a refusal about a character still points at where it was
 * written rather than at the space that used to precede it.
 */
function trim(nodes: Node[]): Node[] {
	let start = 0;
	let end = nodes.length;
	while (start < end && blank(nodes[start])) {
		start++;
	}
	while (end > start && blank(nodes[end - 1])) {
		end--;
	}

	const kept = nodes.slice(start, end);
	return kept.map((node, index) => {
		if (node.kind !== "text") {
			return node;
		}
		const lead = index === 0 ? node.text.length - node.text.trimStart().length : 0;
		const text = index === 0 ? node.text.slice(lead) : node.text;
		const trimmed = index === kept.length - 1 ? text.trimEnd() : text;
		return trimmed === node.text ? node : { ...node, text: trimmed, column: node.column + lead };
	});
}

function blank(node: Node): boolean {
	return node.kind === "text" && node.text.trim().length === 0;
}

/**
 * The nodes that introduce one entry.
 *
 * A written marker is right-aligned in the column the widest one needs, followed by one space: that
 * is what puts the text of `9.` and `10.` in the same place. A drawn one is the checkbox itself, with
 * the same single space after it.
 *
 * Both carry the item's own position, so anything a later stage refuses about them — a codepage that
 * cannot print a digit, for instance — points at the entry the author would have to change.
 *
 * @param item the entry
 * @param body the written marker, or null for a drawn one
 * @param indent columns the list is set in from the left
 * @param width columns the marker column occupies, the space after it included
 * @returns the nodes to place before the entry's content
 */
function marker(item: ItemNode, body: string | null, indent: number, width: number): Node[] {
	if (body === null) {
		const box: Node = { kind: "check", checked: item.done, line: item.line, column: item.column };
		return indent > 0 ? [spaces(indent, item), box, spaces(1, item)] : [box, spaces(1, item)];
	}
	return [text(`${" ".repeat(indent)}${body.padStart(width - 1)} `, item)];
}

/** One entry's marker, without the column it is right-aligned in. */
function markerBody(style: ListStyle, number: number): string {
	switch (style) {
		case "dash":
			return "-";
		case "number":
			return `${number}.`;
		case "letter":
			return `${letters(number)}.`;
		case "check":
			// A checkbox is drawn rather than written, so the caller never asks for its body.
			throw new Error("a check list has no written marker");
	}
}

/**
 * The letters a lettered list counts in: `a`…`z`, then `aa`, `ab` and on.
 *
 * Bijective base 26, the scheme a spreadsheet names its columns by, because the alternative — `z`
 * followed by `ba`, as plain base 26 would give — skips a name a reader expects to see.
 */
function letters(number: number): string {
	let text = "";
	for (let left = number; left > 0; left = Math.floor((left - 1) / 26)) {
		text = LETTERS[(left - 1) % 26] + text;
	}
	return text;
}

function widest(bodies: string[]): number {
	return bodies.reduce((longest, body) => Math.max(longest, body.length), 0);
}

function spaces(count: number, item: ItemNode): Node {
	return text(" ".repeat(count), item);
}

function text(value: string, item: ItemNode): Node {
	return { kind: "text", text: value, line: item.line, column: item.column };
}
