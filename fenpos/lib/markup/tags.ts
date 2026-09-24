import { Align, BarcodeSystem, Font } from "@/lib/domain/enums";
import type { AttributeTable } from "@/lib/markup/attributes";

/**
 * The complete set of markup tags.
 *
 * A closed registry rather than an extensible map, so an unrecognised tag is always a client
 * error with a clear message and never a silently ignored token that would print as literal
 * text. Ported from `Tag.java`, which remains the definition of record for what the printer
 * can be asked to do.
 */

/** Whether a tag wraps content or stands alone. */
export type TagKind = "PAIRED" | "VOID";

/** One tag's rules. */
export interface Tag {
	name: string;
	kind: TagKind;
	attributes: AttributeTable;
}

/**
 * A share of the width the enclosing region offers, rather than of the paper.
 *
 * The same spec on every block that takes one, because a cell inside a box inside a table is
 * measured against what encloses it at each step: a width that meant the paper would leave the
 * author computing the nesting themselves.
 */
const PERCENT = { kind: "integer", min: 1, max: 100 } as const;

/** The strokes a drawn edge can have. */
const BORDER = { kind: "enum", values: ["single", "double", "thick", "none"] } as const;

/** Highest permitted character multiplier, imposed by ESC/POS `GS !`. */
const MULTIPLIER = { kind: "integer", min: 1, max: 8 } as const;

/** What `<chart>` can be drawn as. */
export const CHART_TYPES = ["bar", "line", "pie", "scatter"] as const;

/** Every tag, keyed by the lowercase name written in markup. */
export const TAGS: Record<string, Tag> = {
	/** Emphasis. */
	bold: { name: "bold", kind: "PAIRED", attributes: {} },
	/** Underline; `weight` selects the printer's second, heavier one. */
	underline: { name: "underline", kind: "PAIRED", attributes: { weight: { kind: "integer", min: 1, max: 2 } } },
	/** White on black. */
	invert: { name: "invert", kind: "PAIRED", attributes: {} },
	/** Character multipliers. Either alone leaves the other at 1; neither is refused by the tree. */
	size: { name: "size", kind: "PAIRED", attributes: { width: MULTIPLIER, height: MULTIPLIER } },
	/** A face: one of the printer's own by letter, or a stored font by name, at `size` dots. */
	text: {
		name: "text",
		kind: "PAIRED",
		attributes: {
			font: { kind: "text", maxLength: 64, names: "font", required: true },
			// The printer's own faces are a size as well as a shape, chosen by the hardware, so there is
			// nothing for a size in dots to act on. Stated against the two built-in names because every
			// other name is a stored font, of which this side knows nothing here.
			size: {
				kind: "integer",
				min: 8,
				max: 4096,
				appliesWhen: {
					attribute: "font",
					isNot: Font.values,
					because: "applies to a stored font, not to the printer's own",
				},
			},
		},
	},
	/** Line justification. Paired, and required to own its whole line. */
	align: { name: "align", kind: "PAIRED", attributes: { to: { kind: "enum", values: Align.values, required: true } } },
	/** Break this line at the paper width. Paired, and required to own its whole line. */
	wrap: { name: "wrap", kind: "PAIRED", attributes: {} },
	/** Print this line as written. Paired, and required to own its whole line. */
	nowrap: { name: "nowrap", kind: "PAIRED", attributes: {} },
	/**
	 * Pad to the paper's width with `char`, a space when it is left off.
	 *
	 * The one tag whose printed width is not knowable from the line: it stands for however many
	 * columns are left over, which is a property of the device. See `lib/markup/fill.ts`.
	 */
	fill: { name: "fill", kind: "VOID", attributes: { char: { kind: "char" } } },
	/** Cut the paper, fully unless `mode` says partial. */
	cut: { name: "cut", kind: "VOID", attributes: { mode: { kind: "enum", values: ["full", "partial"] } } },
	/** Advance the paper by `lines`, bounded by ESC/POS `ESC d`. */
	feed: { name: "feed", kind: "VOID", attributes: { lines: { kind: "integer", min: 1, max: 255, required: true } } },
	/**
	 * A checkbox, drawn at the height of the text it sits beside.
	 *
	 * Void, and one of the few drawn things that shares a line with words rather than owning one:
	 * a checkbox with nothing beside it is a box nobody can read.
	 */
	check: { name: "check", kind: "VOID", attributes: { state: { kind: "enum", values: ["off", "on"] } } },
	/**
	 * A list of the items it encloses, marked by `style` and numbered from `start`.
	 *
	 * Owns whole lines, like `<table>`, and holds `<item>` and nothing else. `dash`, `number` and
	 * `letter` are characters the printer draws for itself; `check` draws a box per line, the way
	 * `<check>` does.
	 */
	list: {
		name: "list",
		kind: "PAIRED",
		attributes: {
			style: { kind: "enum", values: ["dash", "number", "letter", "check"] },
			start: { kind: "integer", min: 1, max: 9999 },
		},
	},
	/** One entry of a list; `done` crosses the box of a `check` list. */
	item: { name: "item", kind: "PAIRED", attributes: { done: { kind: "enum", values: ["off", "on"] } } },
	/**
	 * A full-width horizontal rule, drawn with `char` or a dash. Required to be alone on its line.
	 *
	 * The character is the same spec `<fill>` takes, and is held to the same rule: it is expanded to
	 * text on this side, so the codepage has to be able to print it.
	 */
	hr: { name: "hr", kind: "VOID", attributes: { char: { kind: "char" } } },
	/** A QR code; `size` is dots per module, bounded by ESC/POS `GS ( k` function 167. */
	qr: { name: "qr", kind: "PAIRED", attributes: { size: { kind: "integer", min: 1, max: 16 } } },
	/** A linear barcode of the symbology `type` names. */
	barcode: {
		name: "barcode",
		kind: "PAIRED",
		attributes: { type: { kind: "enum", values: BarcodeSystem.values, required: true } },
	},
	/** A PDF417 symbol; `level` is the error-correction level, bounded by ESC/POS `GS ( k` function 069. */
	pdf417: { name: "pdf417", kind: "PAIRED", attributes: { level: { kind: "integer", min: 0, max: 8 } } },
	/** A cash drawer pulse on `pin`, 2 unless said otherwise. */
	drawer: { name: "drawer", kind: "VOID", attributes: { pin: { kind: "enum", values: ["2", "5"] } } },
	/**
	 * A stored image or an `http(s)` URL, printed `width` percent of the paper wide.
	 *
	 * The reference is the content rather than an attribute. A URL routinely contains `=` — `?v=2` —
	 * and may contain `>`, and putting it in the content reuses the `&lt;` and `&amp;` escaping every
	 * other block already has, and adds no parsing rule of its own.
	 */
	image: { name: "image", kind: "PAIRED", attributes: { width: PERCENT } },
	/** A framed region around the lines it encloses. */
	box: {
		name: "box",
		kind: "PAIRED",
		attributes: { width: PERCENT, border: BORDER, pad: { kind: "integer", min: 0, max: 8 } },
	},
	/** A grid of rows and cells. */
	table: {
		name: "table",
		kind: "PAIRED",
		attributes: { width: PERCENT, border: BORDER, group: { kind: "integer", min: 1, max: 50 } },
	},
	/** One row of a table. Holds cells and nothing else. */
	row: { name: "row", kind: "PAIRED", attributes: {} },
	/** One cell of a row. */
	cell: {
		name: "cell",
		kind: "PAIRED",
		attributes: {
			width: PERCENT,
			align: { kind: "enum", values: ["left", "center", "right"] },
			valign: { kind: "enum", values: ["top", "middle", "bottom"] },
			shade: { kind: "enum", values: ["none", "light", "dark", "black"] },
		},
	},
	/** A chart of the series it encloses, drawn as `type`. */
	chart: {
		name: "chart",
		kind: "PAIRED",
		attributes: {
			type: { kind: "enum", values: CHART_TYPES, required: true },
			width: PERCENT,
			height: { kind: "integer", min: 3, max: 60 },
			title: { kind: "text", maxLength: 64 },
			legend: { kind: "enum", values: ["auto", "on", "off"] },
			area: {
				kind: "enum",
				values: ["on", "off"],
				appliesWhen: {
					attribute: "type",
					is: ["line"],
					because: "fills under a line, so it applies to a line chart only",
				},
			},
		},
	},
	/** One series of a chart, its values enclosed as data; `name` is what the legend prints. */
	series: {
		name: "series",
		kind: "PAIRED",
		attributes: {
			name: { kind: "text", maxLength: 64 },
			pattern: { kind: "enum", values: ["solid", "hatch", "dot", "hollow"] },
			// A marker is drawn on a plotted point, and a bar or a pie plots none. The condition names
			// the chart's type rather than the series' own, which is why it is settled when the chart
			// closes instead of when the series opens: a series is read before the chart it is part of
			// is finished.
			marker: {
				kind: "enum",
				values: ["circle", "square", "triangle", "cross", "none"],
				appliesWhen: {
					attribute: "type",
					on: "parent",
					is: ["line", "scatter"],
					because: "draws on plotted points, so it applies to line and scatter charts only",
				},
			},
		},
	},
	/** A chart's category labels, enclosed as data. */
	labels: { name: "labels", kind: "PAIRED", attributes: {} },
	/** A gauge drawn `value` percent full. */
	bar: {
		name: "bar",
		kind: "VOID",
		attributes: { value: { kind: "integer", min: 0, max: 100, required: true }, width: PERCENT },
	},
};

/**
 * Whether a tag encloses data rather than text to be printed.
 *
 * The four content tags are paired like a styling tag but behave nothing like one: what they
 * enclose is the payload of a symbology, or the name of an image, so it is captured verbatim into a
 * directive instead of becoming styled spans. Naming the set here keeps the parser's several checks
 * on it in step.
 *
 * `<drawer>` is not one: it encloses nothing and prints nothing.
 *
 * @param name a tag name, as written in markup
 * @returns true when the tag's content is data rather than text
 */
export function isContentTag(name: string): boolean {
	return name === "qr" || name === "barcode" || name === "pdf417" || name === "image";
}

/**
 * Resolves a tag by the name written in markup, ignoring case.
 *
 * @param name candidate tag name
 * @returns the tag, or undefined if no such tag exists
 */
export function tagByName(name: string): Tag | undefined {
	if (!name) {
		return undefined;
	}
	// `hasOwn` rather than a bare index, because {@link TAGS} is an object literal and so carries
	// `Object.prototype`. Without this, `<constructor>` resolves to a function and `<toString>` to a
	// method, and the parser then reads `.kind` off something that is not a tag — a raw `Error` and a
	// 500 for markup whose only fault is naming a tag that does not exist.
	const lower = name.toLowerCase();
	return Object.hasOwn(TAGS, lower) ? TAGS[lower] : undefined;
}

/**
 * The tags the printer prints for itself, which is why no block may hold one.
 *
 * A block is a region of dots this side draws and sends as a picture. A symbol is encoded by the
 * printer's own firmware and a cut or a feed acts on the paper rather than marking it, so neither
 * is something that can be drawn into a region: there is nothing to draw.
 */
export const PRINTER_DRAWN: ReadonlySet<string> = new Set(["qr", "barcode", "pdf417", "cut", "feed", "drawer"]);

/**
 * The tags that mean nothing on their own, and the one each belongs directly inside.
 *
 * Keyed and valued by tag name rather than by a block's own type, because `<item>` belongs inside
 * `<list>` and neither of those is a block: a list prints characters the device already has.
 */
export const REQUIRED_PARENT: ReadonlyMap<string, string> = new Map([
	["row", "table"],
	["cell", "row"],
	["series", "chart"],
	["labels", "chart"],
	["item", "list"],
]);

/** The tags that hold named tags and nothing else, whitespace and line breaks apart. */
export const HOLDS_ONLY: ReadonlyMap<string, readonly string[]> = new Map([
	["table", ["row"]],
	["row", ["cell"]],
	["chart", ["series", "labels"]],
	["list", ["item"]],
]);

/**
 * The tags no `<item>` may hold.
 *
 * An item is one printed line with a marker in front of it. A region is a block of dots that the
 * layout stacks *below* whatever line it interrupts, and a rule takes the paper's whole width, so
 * either one written inside an item would print somewhere other than beside the marker that
 * introduces it. Refused rather than drawn in the wrong place.
 *
 * `<image>` is deliberately absent: it is the one drawn thing that sits in a row of glyphs, so an
 * image inside an item prints beside the item's own words like any other inline content.
 */
export const NOT_IN_AN_ITEM: ReadonlySet<string> = new Set([
	"box",
	"table",
	"row",
	"cell",
	"chart",
	"series",
	"labels",
	"bar",
	"hr",
]);
