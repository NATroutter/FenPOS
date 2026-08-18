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
		".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
			backgroundColor: "#262626",
		},
		".cm-cursor": { borderLeftColor: "#e5e5e5" },
	},
	{ dark: true },
);
