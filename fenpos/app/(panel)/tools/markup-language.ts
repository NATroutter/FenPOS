import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState, type Extension, RangeSetBuilder, type Text, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { closingFor, contextAt, renameEditsFor, type SourceEdit, suggestionsFor } from "@/lib/markup/editor-language";
import { type SpanKind, scan } from "@/lib/markup/scan";
import { ENTITIES } from "@/lib/markup/tokenizer";

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

/**
 * What may be written at the caret.
 *
 * Every candidate comes from the tag registry, so the editor cannot offer something the parser would
 * refuse. A suggestion carrying no label is a description of what an attribute accepts — an integer's
 * range has nothing to list — and is shown without being offered as a completion.
 */
function markupCompletions(context: CompletionContext): CompletionResult | null {
	const source = context.state.doc.toString();
	const caret = contextAt(source, context.pos);

	if (!caret.inHeader) {
		const entity = entityAt(source, context.pos);
		if (entity === null) {
			return null;
		}
		return {
			from: entity,
			to: context.pos,
			options: ENTITIES.map(([written]) => ({ label: written })),
			validFor: /^&[a-z]*;?$/i,
		};
	}

	const options = suggestionsFor(caret, source)
		.filter((suggestion) => suggestion.label.length > 0)
		.map((suggestion) => ({ label: suggestion.label, detail: suggestion.detail }));
	if (options.length === 0) {
		return null;
	}
	return { from: caret.word.from, to: caret.word.to, options, validFor: /^[a-z0-9_-]*$/i };
}

/**
 * Where an entity being typed starts, when the caret is inside one.
 *
 * Only an unterminated run — `&`, `&l`, `&amp` — is one being typed. Once the `;` is there the entity
 * is written, and offering to replace it with itself helps nobody.
 */
function entityAt(source: string, offset: number): number | null {
	const start = source.lastIndexOf("&", Math.max(0, offset - 1));
	if (start < 0) {
		return null;
	}
	return /^&[a-z]*$/i.test(source.slice(start, offset)) ? start : null;
}

/**
 * Whether a `>` typed over this range could end a tag header, read from the line it lands on.
 *
 * A header is line-local, so the line the `>` falls on holds everything this turns on, and a `>` typed
 * in ordinary text is turned away without reading a document that may run to a million characters. A
 * replacement reaching past the line's own end is not a question one line can answer, and is passed on
 * rather than refused.
 */
function mayEndHeader(doc: Text, from: number, to: number): boolean {
	const line = doc.lineAt(from);
	if (to > line.to) {
		return true;
	}
	const typed = `${line.text.slice(0, from - line.from)}>${line.text.slice(to - line.from)}`;
	const at = from - line.from + 1;
	return scan(typed).some((span) => span.kind === "tag-punctuation" && span.to === at && typed[span.from] === ">");
}

/**
 * Closes a paired tag as its `>` is typed, leaving the caret between the two.
 *
 * `closingFor` decides: a void tag encloses nothing, a name no registry knows may not be a tag at
 * all, a `>` inside a quoted value is a character, and a tag that already has its close must not get
 * a second one. Whether it is asked at all is decided from the caret's own line, because it reads the
 * whole document to find out whether the tag is closed already.
 */
const autoClose = EditorView.inputHandler.of((view, from, to, text) => {
	if (text !== ">" || !mayEndHeader(view.state.doc, from, to)) {
		return false;
	}
	const source = view.state.doc.toString();
	const typed = `${source.slice(0, from)}>${source.slice(to)}`;
	const closing = closingFor(typed, from + 1);
	if (closing === null) {
		return false;
	}
	view.dispatch({
		changes: { from, to, insert: `>${closing}` },
		selection: { anchor: from + 1 },
		userEvent: "input.type",
	});
	return true;
});

/**
 * Whether an edit at this offset falls on a tag's name, read from the line the edit lands on.
 *
 * A tag, its attributes and its punctuation all stop at the line's own end, so one line places a name
 * exactly where a pass over the whole document would place it. An offset counts as on a name at either
 * of its ends, which is what the search for a partner does, so that a character appended to a name
 * belongs to it.
 */
function editsTagName(doc: Text, offset: number): boolean {
	const line = doc.lineAt(offset);
	const at = offset - line.from;
	return scan(line.text).some((span) => span.kind === "tag-name" && span.from <= at && at <= span.to);
}

/**
 * Rewrites a tag's partner as its name is edited.
 *
 * Read from the document as it was before the change, so the pair is found while both names still
 * agree. Where the document is unbalanced around the caret there is no honest partner, and the edit
 * is left alone rather than a guess being rewritten.
 *
 * This is a filter over every transaction that changes the document, so it sits on the keystroke. An
 * edit that is nowhere near a tag name is turned away by reading its own line, before the search for a
 * partner reads a document that may run to a million characters — which the overwhelming majority of
 * keystrokes have no use for.
 *
 * Undo and redo are left out. Both replay changes this filter has already seen, and reading them again
 * would have an undo compose edits of its own rather than restore what it undid.
 */
const linkedRename = EditorState.transactionFilter.of((transaction: Transaction) => {
	if (
		!transaction.docChanged ||
		transaction.isUserEvent("input.type.compose") ||
		transaction.isUserEvent("undo") ||
		transaction.isUserEvent("redo")
	) {
		return transaction;
	}

	const { doc } = transaction.startState;
	const changes: SourceEdit[] = [];
	let onName = false;

	transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		changes.push({ from: fromA, to: toA, insert: inserted.toString() });
		onName = onName || editsTagName(doc, fromA);
	});

	if (!onName) {
		return transaction;
	}

	const edits = renameEditsFor(doc.toString(), changes);
	if (edits.length === 0) {
		return transaction;
	}
	// Not `sequential`. The offsets above were read from `transaction.startState`, and specs combined
	// without that flag are all taken to refer to that same starting document. Marking this one
	// sequential would have CodeMirror read those offsets against the document the user's own edit
	// produced instead — a different position whenever the edit changed the length of anything before
	// the partner, which renaming a tag usually does.
	return [transaction, { changes: edits }];
});

/** Everything the markup editor adds to CodeMirror, as one extension. */
export function markupLanguage(): Extension[] {
	return [highlighting, autocompletion({ override: [markupCompletions] }), autoClose, linkedRename];
}
