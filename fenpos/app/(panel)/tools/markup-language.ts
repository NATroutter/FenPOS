import {
	acceptCompletion,
	autocompletion,
	type Completion,
	type CompletionContext,
	type CompletionResult,
	startCompletion,
} from "@codemirror/autocomplete";
import { linter, lintGutter, setDiagnostics } from "@codemirror/lint";
import {
	EditorState,
	type Extension,
	Prec,
	RangeSetBuilder,
	StateEffect,
	StateField,
	type Text,
	type Transaction,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { diagnosticsFor, type PositionedError } from "@/lib/markup/diagnostics";
import {
	closingFor,
	contextAt,
	entityAt,
	headerNameAt,
	maySuggest,
	renameEditsFor,
	renamePairFor,
	type SourceEdit,
	type StoredNames,
	suggestionsFor,
	variableAt,
	variableSuggestions,
} from "@/lib/markup/editor-language";
import { type Span, type SpanKind, scan } from "@/lib/markup/scan";
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

/**
 * The class one span is painted with, read from the line it was scanned out of.
 *
 * The scanner has one kind for every mark a tag is written with, because they are all punctuation to
 * a reader asking what the caret is inside. An editor colours them in two groups: the `<`, `/` and `>`
 * that bound a tag, and the `=` and quotes that bind a value to its name, which read as part of the
 * value rather than as part of the tag around it.
 */
function classFor(span: Span, text: string): string | null {
	if (span.kind !== "tag-punctuation") {
		return CLASS[span.kind];
	}
	const written = text[span.from];
	return written === "=" || written === '"' ? CLASS["attribute-value"] : CLASS["tag-punctuation"];
}

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
				const className = classFor(span, line.text);
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
 * Marks the tag the caret is in and the one it pairs with, so the other end of a block is visible
 * without hunting for it.
 *
 * Both halves are marked rather than only the far one: a mark that appeared somewhere else on the
 * screen while nothing changed under the caret reads as the editor highlighting an unrelated word.
 * Marked together they read as a pair, which is what they are.
 *
 * The caret's own line decides whether the question is worth asking, exactly as the linked rename
 * does and for the same reason: a header is line-local, so one line says whether the caret is in a
 * tag at all, and only then is the whole document — which may run to a million characters — read to
 * find the partner. A caret moving through ordinary text never pays for that.
 *
 * Nothing is marked where there is no honest answer: a void tag closes nothing, and neither does a
 * name whose partner is missing or whose nesting does not balance around the caret.
 */
function matchesFor(view: EditorView): DecorationSet {
	const { state } = view;
	const head = state.selection.main.head;
	const line = state.doc.lineAt(head);

	const name = headerNameAt(line.text, head - line.from);
	if (!name) {
		return Decoration.none;
	}

	const subject = { from: line.from + name.from, to: line.from + name.to };
	const partner = renamePairFor(state.doc.toString(), subject.from);
	if (!partner) {
		return Decoration.none;
	}

	// Sorted, because `Decoration.set` is given the ranges in document order and the partner may lie
	// either side of the caret: a closing tag pairs with a name above it, an opening one below.
	const both = [subject, partner].sort((first, second) => first.from - second.from);
	return Decoration.set(both.map((range) => mark("cm-mk-matched").range(range.from, range.to)));
}

const tagMatching = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = matchesFor(view);
		}

		update(update: ViewUpdate): void {
			// `selectionSet` as well as `docChanged`: this follows the caret, and moving it with an arrow
			// key changes nothing about the document.
			if (update.docChanged || update.selectionSet) {
				this.decorations = matchesFor(update.view);
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
 *
 * `stored` is the one thing the registry cannot supply: what an attribute may *name* depends on what
 * this install holds, which is a database away from a tag table. It is captured when the extension is
 * built rather than read here, because a completion source runs on the keystroke and has nowhere to
 * await anything.
 */
function markupCompletions(context: CompletionContext, stored: StoredNames): CompletionResult | null {
	const source = context.state.doc.toString();
	const caret = contextAt(source, context.pos);

	if (!caret.inHeader) {
		return variableCompletions(source, context.pos, stored) ?? entityCompletions(source, context.pos);
	}

	// A `</` is already followed by its `>` when the closing tag was inserted whole and the name is
	// being retyped into it. Finishing the tag again would write a second one.
	const terminated = source[context.pos] === ">";

	const options = suggestionsFor(caret, source, stored)
		.filter((suggestion) => suggestion.label.length > 0)
		.map((suggestion) => ({
			label: suggestion.label,
			detail: suggestion.detail,
			// Two of the four kinds carry the punctuation that follows them, because in both cases the
			// name alone is half of something. An attribute is written `name=value`, so accepting its
			// name writes the `=` and `opensValue` below asks what may go after it. A closing tag has
			// nowhere else to go at all — `</bold` is only ever on its way to `</bold>` — so accepting
			// one finishes it.
			apply:
				suggestion.kind === "attribute"
					? `${suggestion.label}=`
					: suggestion.kind === "closing" && !terminated
						? `${suggestion.label}>`
						: undefined,
		}));
	if (options.length === 0) {
		return null;
	}
	return { from: caret.word.from, to: caret.word.to, options, validFor: /^[a-z0-9_-]*$/i };
}

/**
 * The variables a `{name}` being typed may resolve to.
 *
 * Accepting one writes the closing brace as well, for the reason a closing tag's completion writes
 * its `>`: `{phone` is only ever on its way to `{phone}`, and a reference left unclosed prints as
 * the literal text an author did not mean. A brace already written is not doubled.
 *
 * Nothing is offered where the install defines no variables, which is also how it answers while
 * variables are switched off: a brace is ordinary text then, and a name offered for one would
 * promise a substitution that will not happen.
 */
function variableCompletions(source: string, pos: number, stored: StoredNames): CompletionResult | null {
	const reference = variableAt(source, pos);
	if (reference === null) {
		return null;
	}

	const options = variableSuggestions(stored.variables ?? []).map((suggestion) => ({
		label: suggestion.label,
		detail: suggestion.detail,
		apply: reference.terminated ? undefined : `${suggestion.label}}`,
	}));
	if (options.length === 0) {
		return null;
	}

	return { from: reference.from, to: reference.to, options, validFor: /^[a-z0-9_-]*$/i };
}

/** The entities an `&` being typed may become. */
function entityCompletions(source: string, pos: number): CompletionResult | null {
	const entity = entityAt(source, pos);
	if (entity === null) {
		return null;
	}
	return {
		from: entity,
		to: pos,
		options: ENTITIES.map(([written]) => ({ label: written })),
		validFor: /^&[a-z]*;?$/i,
	};
}

/**
 * Whether accepting this suggestion should open another straight away.
 *
 * True of exactly the completions that write an `=`, which are the attribute names: what they insert
 * is half of `name=value`, and the caret is left at the half nobody has written yet. Read off what
 * the completion inserts rather than from a flag beside it, because that is the property the
 * behaviour actually turns on — a completion that stops at a `=` is one with something after it.
 */
function opensValue(completion: Completion): boolean {
	return typeof completion.apply === "string" && completion.apply.endsWith("=");
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

/**
 * Asks again what may be written here after a deletion.
 *
 * **CodeMirror opens a completion on typing and on nothing else.** Worse for a value being cleared,
 * it closes an open one as soon as a backspace reaches the position that completion started at. Those
 * two together left the editor silent exactly where an author most wants it: clearing `to=center` to
 * write some other alignment goes quiet part-way through, and is quietest at the end, when the value
 * is empty and every value the attribute accepts is on offer.
 *
 * Every deletion is covered rather than backspace alone, because a forward delete and a selection
 * replaced by nothing leave the caret in the same half-written value.
 *
 * Dispatched from a microtask rather than from the listener itself, because `EditorView.update`
 * refuses to run while an update is in progress. By then the source decides as it always does: it
 * answers with nothing where there is nothing to offer, and no suggestions are shown.
 */
const suggestAfterDeleting = EditorView.updateListener.of((update: ViewUpdate) => {
	if (!update.docChanged || !update.transactions.some((transaction) => transaction.isUserEvent("delete"))) {
		return;
	}

	const caret = update.state.selection.main;
	if (!caret.empty) {
		return;
	}
	const line = update.state.doc.lineAt(caret.head);
	if (!maySuggest(line.text, caret.head - line.from)) {
		return;
	}

	queueMicrotask(() => startCompletion(update.view));
});

/** Asks for the guide to stand at this many columns; zero, or less, puts it away. */
const setPrintWidth = StateEffect.define<number>();

/**
 * How many columns the guide is currently drawn at, zero for not drawn.
 *
 * Held in the document's state rather than baked into the extension the editor was built with, so
 * that switching the guide on, or changing to a printer of another width, is a transaction instead
 * of a reconfiguration. The difference matters: reconfiguring drops what `setDiagnostics` put in the
 * lint state, so a rule toggled on would have taken the underlines with it until the next compile.
 */
const printWidthColumns = StateField.define<number>({
	create: () => 0,
	update: (columns, transaction) => {
		for (const effect of transaction.effects) {
			if (effect.is(setPrintWidth)) {
				return effect.value;
			}
		}
		return columns;
	},
});

/**
 * A rule where the paper runs out, drawn only when it is asked for.
 *
 * **What it is honest about, and what it is not.** The rule stands at the chosen device's column
 * count measured in the editor's own character width, so it answers for a line of plain text and
 * nothing else. Tags are the bigger half of that: `<align to=center>` is seventeen source characters
 * that print none at all, so a line carrying tags reaches the rule long before it fills the paper.
 * `<size width=2>` is the same problem from the other side, every character costing two columns.
 * Either would need the document laid out here as well as on the server to answer properly, which is
 * a second layout engine's worth of work for a guide — so the guide stays off unless someone turns
 * it on, and what it measures is written beside the switch.
 *
 * Drawn as a background on the content rather than an element placed over it: a gradient scrolls
 * with the text it measures and cannot land on top of a glyph or swallow a click.
 *
 * The position is read through `requestMeasure`, which is where CodeMirror does its own layout
 * reads — taking a rectangle during an update would force a reflow on a keystroke.
 */
function printWidthGuide(): Extension {
	return [
		printWidthColumns,
		ViewPlugin.fromClass(
			class {
				constructor(view: EditorView) {
					this.place(view);
				}

				update(update: ViewUpdate): void {
					// Geometry, or the width it is meant to stand at. The rule moves when the font, the zoom
					// or the editor's width changes, and none of those follow from the document's content.
					const columns = update.state.field(printWidthColumns);
					if (update.geometryChanged || update.startState.field(printWidthColumns) !== columns) {
						this.place(update.view);
					}
				}

				/**
				 * Taking the rule away is done here and now; putting it somewhere needs a measurement.
				 *
				 * The asymmetry is deliberate. A measurement runs in `requestMeasure`, which CodeMirror
				 * schedules on an animation frame — and a frame is exactly what a browser stops handing
				 * out while the tab is in the background. Switching the guide off through a measure left
				 * the rule standing in a tab nobody was looking at, to be found still there on the way
				 * back. Removing a custom property reads no layout, so it need not wait for anything.
				 */
				private place(view: EditorView): void {
					if (view.state.field(printWidthColumns) < 1) {
						// Removed rather than set to a hiding value, so the theme's own fallback decides where
						// an unmeasured rule parks and there is one answer to that instead of two.
						view.contentDOM.style.removeProperty("--cm-print-width");
						return;
					}

					view.requestMeasure({
						read: (measured) => {
							const columns = measured.state.field(printWidthColumns);
							if (columns < 1) {
								return null;
							}
							// A line's own left padding, rather than the coordinates of the first character. Both
							// give the same number in a laid-out editor, but `coordsAtPos` measures through a DOM
							// range and throws where one cannot be measured — an editor rendered to zero width by
							// the split handle, or never shown at all. A guide is furniture; it must not be able
							// to take the editor down with it.
							const line = measured.contentDOM.firstElementChild;
							const indent = line ? Number.parseFloat(getComputedStyle(line).paddingLeft) || 0 : 0;
							return indent + columns * measured.defaultCharacterWidth;
						},
						write: (left, measured) => {
							if (left === null) {
								measured.contentDOM.style.removeProperty("--cm-print-width");
								return;
							}
							measured.contentDOM.style.setProperty("--cm-print-width", `${Math.round(left)}px`);
						},
					});
				}
			},
		),
	];
}

/**
 * Stands the print-width guide at a device's column count, or puts it away.
 *
 * @param view the editor to draw it in
 * @param columns the device's width in printer columns; zero, or less, draws no guide at all —
 *   which is what an editor with no device chosen, or with the guide switched off, asks for
 */
export function showPrintWidth(view: EditorView, columns: number): void {
	if (view.state.field(printWidthColumns, false) === columns) {
		return;
	}
	view.dispatch({ effects: setPrintWidth.of(columns) });
}

/**
 * Hands the compiler's refusals to the editor, to be underlined where they happened.
 *
 * A transaction rather than a `linter()` source, because nothing here decides what is wrong: the
 * errors come from the same server compile the paper preview runs, already positioned, and a second
 * opinion computed in the browser is exactly the disagreement that pipeline exists to prevent. The
 * lint extension enables itself on the first call — see `setDiagnostics` — so nothing has to be
 * mounted for a document that never fails.
 *
 * CodeMirror maps what it holds through every edit, so a marker follows the text it was placed on
 * until the next preview replaces the set. That is what keeps an underline under the right word
 * while the author is still typing the fix.
 *
 * @param view the editor to mark up
 * @param errors what the compile refused, or none when it compiled clean
 */
export function showMarkupErrors(view: EditorView, errors: readonly PositionedError[]): void {
	const diagnostics = diagnosticsFor(errors, view.state.doc.toString());
	view.dispatch(setDiagnostics(view.state, diagnostics));
}

/**
 * Accepts the open suggestion on Tab, as well as on Enter.
 *
 * At the highest precedence, because the editor binds Tab to indentation and whichever binding is
 * asked first wins. `acceptCompletion` declines when no suggestion is open, so Tab still indents
 * everywhere else.
 */
const acceptOnTab = Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }]));

/**
 * Everything the markup editor adds to CodeMirror, as one extension.
 *
 * @param stored what this install holds for the places markup names something. Defaults to nothing,
 *   which costs the stored half of a `font=` suggestion — the printer's own faces are offered either
 *   way — and the `{name}` suggestions entirely, so an editor mounted without it still works rather
 *   than failing to build.
 */
export function markupLanguage(stored: StoredNames = {}): Extension[] {
	return [
		highlighting,
		autocompletion({
			override: [(context) => markupCompletions(context, stored)],
			activateOnCompletion: opensValue,
		}),
		tagMatching,
		acceptOnTab,
		autoClose,
		linkedRename,
		suggestAfterDeleting,
		// **Both halves, mounted statically, and the static part is the point.** `setDiagnostics` will
		// bring the underlines along by itself, through `StateEffect.appendConfig` — but appended
		// config is exactly what a reconfiguration drops, and the editor reconfigures whenever the
		// component re-renders with new props. That left the gutter marker standing, because
		// `lintGutter` keeps a state field of its own, while the underline under the text appeared and
		// then vanished a moment later.
		//
		// `linter(null)` is how the library spells "mount the lint extension and give it no source of
		// its own": with no sources its plugin's run loop does nothing at all, so the only diagnostics
		// this editor ever holds are the ones the server compile put there.
		linter(null),
		lintGutter(),
		// Mounted always and drawn on request, for the same reason as the two above: what the rule
		// stands at is state, so the editor is never rebuilt to move it. See {@link showPrintWidth}.
		printWidthGuide(),
	];
}
