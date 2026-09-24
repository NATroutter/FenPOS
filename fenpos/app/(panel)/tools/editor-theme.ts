import { EditorView } from "@codemirror/view";

/**
 * CodeMirror styling that matches the panel.
 *
 * Written as an extension rather than pulled from a theme package: the panel already has its
 * colour tokens, and importing a whole theme to get a dark background would leave two sources of
 * truth for what "surface" means, differing by a shade nobody chose.
 */
export const editorTheme = EditorView.theme(
	{
		"&": {
			backgroundColor: "transparent",
			color: "#e5e5e5",
			fontSize: "12.5px",
		},
		".cm-content": {
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			caretColor: "#e5e5e5",
			// The paper's right edge, in the grey-blue the punctuation is drawn in and thinned until it
			// reads as furniture rather than as a mark on the text. It was the card's hairline `#262626`,
			// which is the colour of an edge nobody chose to see — wrong for a rule somebody switched on
			// deliberately, and easy to mistake for a rendering fault. Matched tags already wash in this
			// hue, so the guide belongs to the same quiet family instead of taking a colour of its own.
			//
			// `printWidthGuide` keeps the offset, and removes it when the rule is off; the fallback here
			// is what "off" looks like, parking it off the left edge rather than drawing it at zero.
			backgroundImage:
				"linear-gradient(to right, transparent var(--cm-print-width, -10px), color-mix(in oklab, #9daab2 45%, transparent) var(--cm-print-width, -10px), color-mix(in oklab, #9daab2 45%, transparent) calc(var(--cm-print-width, -10px) + 1px), transparent calc(var(--cm-print-width, -10px) + 1px))",
			backgroundRepeat: "no-repeat",
		},
		".cm-gutters": {
			backgroundColor: "transparent",
			color: "#525252",
			border: "none",
		},
		".cm-activeLineGutter": { backgroundColor: "transparent" },
		"&.cm-focused": { outline: "none" },
		// The accent, matching what selecting text anywhere else in the panel does. It was #262626,
		// which is the hairline colour: legible as a border against a card, almost invisible as a
		// wash behind text in the well.
		//
		// All three selectors are needed, and the long one is not optional. CodeMirror's own base
		// theme styles the focused selection through
		// `&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`, which outranks
		// a plain `.cm-selectionBackground` on specificity — so styling only the short form changes
		// the colour of an unfocused selection and leaves the one you are actually making alone.
		// The `::selection` entry covers the native selection, used when the editor is not focused.
		"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
			{
				backgroundColor: "color-mix(in oklab, var(--brand) 35%, transparent)",
			},
		".cm-cursor": { borderLeftColor: "#e5e5e5" },
		".cm-mk-tag": { color: "#df6054" },
		".cm-mk-attr": { color: "#c97242" },
		// The `=` and the quotes are painted with this too: they bind a value to its name and read as
		// part of it, where `<`, `/` and `>` bound the tag around them.
		".cm-mk-value": { color: "#97a956" },
		".cm-mk-punct": { color: "#9daab2" },
		// The tag the caret is in and the one it pairs with. A wash behind the name rather than a
		// colour on it: the names keep the colour that says what they are, and the pair reads as two
		// marks of the same shape at opposite ends of a block. Drawn in the bracket grey rather than
		// the accent, which selecting text already uses — two different things lighting up in the same
		// colour is how a selection and a match stop being told apart.
		".cm-mk-matched": {
			backgroundColor: "color-mix(in oklab, #9daab2 24%, transparent)",
			borderRadius: "2px",
		},
		// What the compiler refused, underlined where it happened. CodeMirror's own lint theme draws a
		// wavy SVG in a red of its own choosing and a gutter dot to match; both are restated here in
		// the panel's destructive red so a refusal in the editor and the refusal listed beside the
		// paper are visibly the same judgement.
		//
		// The underline is a gradient rather than `text-decoration`, because a decoration on a span
		// that already carries a syntax colour inherits that colour — a red fault under a green value
		// would have been drawn in green.
		".cm-lintRange-error": {
			backgroundImage: "none",
			borderBottom: "2px dotted #e26a6a",
			paddingBottom: "1px",
		},
		".cm-lint-marker-error": { content: "none", backgroundColor: "#e26a6a", borderRadius: "50%" },
		".cm-gutter-lint": { width: "0.8em" },
		".cm-gutter-lint .cm-gutterElement": { padding: "0 0 0 0.2em" },
		".cm-tooltip.cm-tooltip-lint": {
			backgroundColor: "#161616",
			border: "1px solid #262626",
			borderRadius: "6px",
			color: "#e5e5e5",
			fontSize: "12px",
			maxWidth: "34rem",
			padding: "2px",
		},
		".cm-diagnostic": { borderLeft: "none", padding: "5px 8px" },
		".cm-diagnostic-error": { borderLeft: "2px solid #e26a6a" },
		".cm-mk-entity": { color: "#a3a3a3", fontStyle: "italic" },
		// Brighter than anything else here, and the one cool-violet in a palette that is otherwise a
		// warm red-orange-olive with a grey-blue for punctuation. Both halves are deliberate. A
		// reference is the only thing in a document whose printed text nobody can read off the screen,
		// so it earns the highest-contrast colour on the line; and it takes the hue no other token
		// uses, because the greys it used to share with `<entity>` made the two indistinguishable and
		// anything warmer would have sat between the tag red and the attribute orange.
		//
		// Still italic, as an entity is: both stand for text rather than being it, and the slant is
		// what keeps saying so once a reader has stopped reading colours.
		".cm-mk-variable": { color: "#b08ee0", fontStyle: "italic" },
	},
	{ dark: true },
);
