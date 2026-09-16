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
 * Colours the document from the markup scanner.
 *
 * The whole document is rescanned on every change rather than parsed incrementally. A receipt is
 * bounded by the device's own line and character limits, so the work is small and the alternative
 * would be a second, incremental definition of a syntax this project already defines once.
 */
function decorationsFor(source: string): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	for (const span of scan(source)) {
		const className = CLASS[span.kind];
		if (className && span.to > span.from) {
			builder.add(span.from, span.to, mark(className));
		}
	}
	return builder.finish();
}

const highlighting = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = decorationsFor(view.state.doc.toString());
		}

		update(update: ViewUpdate): void {
			if (update.docChanged) {
				this.decorations = decorationsFor(update.state.doc.toString());
			}
		}
	},
	{ decorations: (plugin) => plugin.decorations },
);

/** Everything the markup editor adds to CodeMirror, as one extension. */
export function markupLanguage(): Extension[] {
	return [highlighting];
}
