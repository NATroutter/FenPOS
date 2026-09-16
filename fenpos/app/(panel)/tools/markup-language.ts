import { type Extension, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type SpanKind, scan } from "@/lib/markup/scan";

/** The class each kind of span is painted with. Styling lives in `editor-theme.ts`. */
const CLASS: Record<SpanKind, string | null> = {
	"tag-punctuation": "cm-mk-punct",
	"tag-name": "cm-mk-tag",
	"attribute-name": "cm-mk-attr",
	"attribute-value": "cm-mk-value",
	entity: "cm-mk-entity",
	variable: "cm-mk-variable",
	text: null,
};

const MARKS = new Map<string, Decoration>();

function mark(className: string): Decoration {
	const existing = MARKS.get(className);
	if (existing) {
		return existing;
	}
	const created = Decoration.mark({ class: className });
	MARKS.set(className, created);
	return created;
}

/**
 * Colours the visible part of the document from the markup scanner.
 *
 * Only the lines CodeMirror is actually showing are scanned, not the whole document. At the
 * operator-settable ceiling (10,000 lines, up to 1,000,000 characters), scanning the whole document
 * costs around 12ms per keystroke — well past a keystroke's budget — while every styled span is
 * line-local (a tag, its attributes and its punctuation stop at the line's own end; an entity is a
 * fixed literal with no newline in it; a variable reference matches name characters only), so a
 * per-line scan produces exactly the same styled spans as scanning the whole document would. Text
 * spans can cross lines, but text is left unstyled (`CLASS.text` is `null`), so nothing is lost by
 * not producing those spans for an off-screen line.
 *
 * `view.visibleRanges` is expanded to whole lines because `scan` reads a line's own start and end to
 * bound a tag; handing it a range that begins or ends mid-line would cut a span in a place the
 * document itself does not.
 */
function decorationsFor(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const { doc } = view.state;
	// Ranges processed so far, as a line number: keeps a rescanned viewport from adding a line
	// already covered by an earlier range in the same pass, which would offer `RangeSetBuilder` a
	// position behind what it has already seen.
	let coveredThrough = 0;

	for (const { from, to } of view.visibleRanges) {
		const firstLine = Math.max(doc.lineAt(from).number, coveredThrough + 1);
		const lastLine = doc.lineAt(to).number;

		for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
			const line = doc.line(lineNumber);
			for (const span of scan(line.text)) {
				const className = CLASS[span.kind];
				// `Decoration.mark` refuses an empty range, and a scanner boundary can coincide with
				// itself (an unterminated tag at the end of a line, say) without that being a defect.
				if (className && span.to > span.from) {
					builder.add(line.from + span.from, line.from + span.to, mark(className));
				}
			}
		}

		coveredThrough = Math.max(coveredThrough, lastLine);
	}

	return builder.finish();
}

const highlighting = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = decorationsFor(view);
		}

		update(update: ViewUpdate): void {
			// `viewportChanged` as well as `docChanged`: scrolling reveals lines that were never
			// scanned because they were never visible, and an edit can move which lines are visible
			// without changing the viewport's own coordinates.
			if (update.docChanged || update.viewportChanged) {
				this.decorations = decorationsFor(update.view);
			}
		}
	},
	{ decorations: (plugin) => plugin.decorations },
);

/** Everything the markup editor adds to CodeMirror, as one extension. */
export function markupLanguage(): Extension[] {
	return [highlighting];
}
