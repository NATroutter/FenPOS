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

/** Whether a tag accepts a `=value` argument. */
export type TagArgument = "NONE" | "OPTIONAL" | "REQUIRED";

/** One tag's rules. */
export interface Tag {
	name: string;
	kind: TagKind;
	argument: TagArgument;
}

/** Every tag, keyed by the lowercase name written in markup. */
export const TAGS: Record<string, Tag> = {
	/** Emphasis. */
	bold: { name: "bold", kind: "PAIRED", argument: "NONE" },
	/** Underline, optionally selecting the printer's second weight. */
	underline: { name: "underline", kind: "PAIRED", argument: "OPTIONAL" },
	/** White on black. */
	invert: { name: "invert", kind: "PAIRED", argument: "NONE" },
	/** Character multipliers, as `W,H` or a single value used for both. */
	size: { name: "size", kind: "PAIRED", argument: "REQUIRED" },
	/** Built-in font selection. */
	font: { name: "font", kind: "PAIRED", argument: "REQUIRED" },
	/** Line justification. Paired, and required to enclose the whole element. */
	align: { name: "align", kind: "PAIRED", argument: "REQUIRED" },
	/** Break this line at the paper width. Paired, and required to enclose the whole element. */
	wrap: { name: "wrap", kind: "PAIRED", argument: "NONE" },
	/** Print this line as written. Paired, and required to enclose the whole element. */
	nowrap: { name: "nowrap", kind: "PAIRED", argument: "NONE" },
	/** Cut the paper, fully by default. */
	cut: { name: "cut", kind: "VOID", argument: "OPTIONAL" },
	/** Advance the paper by a number of lines. */
	feed: { name: "feed", kind: "VOID", argument: "REQUIRED" },
	/** A full-width horizontal rule. Required to be alone in its element. */
	hr: { name: "hr", kind: "VOID", argument: "NONE" },
	/** A QR code. Argument is the module size, 1-16. */
	qr: { name: "qr", kind: "PAIRED", argument: "OPTIONAL" },
	/** A linear barcode. Argument is the symbology. */
	barcode: { name: "barcode", kind: "PAIRED", argument: "REQUIRED" },
	/** A PDF417 symbol. Argument is the error-correction level, 0-8. */
	pdf417: { name: "pdf417", kind: "PAIRED", argument: "OPTIONAL" },
	/** A cash drawer pulse. Argument is the pin, 2 or 5. */
	drawer: { name: "drawer", kind: "VOID", argument: "OPTIONAL" },
	/**
	 * A stored image or an `http(s)` URL. Argument is the printed width as a percentage of the
	 * paper, 1-100.
	 *
	 * Paired rather than `<image=logo>`, which is the shape the reference first had. A URL routinely
	 * contains `=` — `?v=2` — and may contain `>`, so an argument-shaped reference would be split at
	 * the first one. Putting it in the content reuses the `&lt;` and `&amp;` escaping every other
	 * block already has, and adds no parsing rule of its own.
	 */
	image: { name: "image", kind: "PAIRED", argument: "OPTIONAL" },
};

/**
 * Whether a tag encloses data rather than text to be printed.
 *
 * The four block tags are paired like a styling tag but behave nothing like one: what they enclose
 * is the payload of a symbology, or the name of an image, so it is captured verbatim into a
 * directive instead of becoming styled spans. Naming the set here keeps the parser's several checks
 * on it in step.
 *
 * `<drawer>` is not one: it encloses nothing and prints nothing.
 *
 * @param name a tag name, as written in markup
 * @returns true when the tag's content is data rather than text
 */
export function isBlockTag(name: string): boolean {
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
	return TAGS[name.toLowerCase()];
}
