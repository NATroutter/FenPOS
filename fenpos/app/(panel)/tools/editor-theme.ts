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
	},
	{ dark: true },
);
