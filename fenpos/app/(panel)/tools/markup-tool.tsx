"use client";

import { EditorSelection, type Extension } from "@codemirror/state";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
	ALargeSmall,
	AlignCenter,
	Bold,
	BookOpen,
	Braces,
	ChevronDown,
	CircleAlert,
	CircleCheck,
	Code,
	Contrast,
	Eraser,
	Plus,
	Printer,
	ReceiptText,
	Ruler,
	Underline,
} from "lucide-react";
import {
	type CSSProperties,
	Fragment,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useTransition,
} from "react";
import { toast } from "sonner";
import {
	type PreviewError,
	type PreviewLine,
	type PreviewResult,
	preview,
	printMarkup,
} from "@/app/(panel)/tools/actions";
import type { ToolDevice } from "@/app/(panel)/tools/device-picker";
import { DevicePicker } from "@/app/(panel)/tools/device-picker";
import { editorTheme } from "@/app/(panel)/tools/editor-theme";
import { InsertDialog, type InsertTag } from "@/app/(panel)/tools/insert-dialog";
import { markupLanguage, showMarkupErrors, showPrintWidth } from "@/app/(panel)/tools/markup-language";
import { ImagePreview } from "@/components/panel/image-preview";
import { useSessionState } from "@/components/panel/session-state";
import { SymbolPreview } from "@/components/panel/symbol-preview";
import { Button } from "@/components/ui/button";
import { Card, CardActions, CardContent, CardHeader } from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Linefeed } from "@/lib/domain/enums";
import { type InsertData, markupEdit, variableEdit } from "@/lib/markup/editing";
import type { VariableName } from "@/lib/markup/editor-language";

/** How long the editor sits still before a preview is compiled. */
const DEBOUNCE_MS = 300;

/**
 * The editor's extensions, rebuilt only when what this install holds changes.
 *
 * Building them once at module load was enough until `font=` needed to offer what this install
 * holds: a new array on every render reconfigures the editor on every keystroke. Both lists arrive
 * from the server with the page and do not change while it is open, so this memoises on the two
 * things that could — keyed on their serialised form, because each arrives as a new array identity
 * every render and would defeat the memo it was handed to.
 */
function useMarkupExtensions(fonts: readonly string[], variables: readonly VariableName[]): Extension[] {
	const fontKey = fonts.join("\n");
	const variableKey = JSON.stringify(variables);
	return useMemo(
		() =>
			markupLanguage({
				fonts: fontKey === "" ? [] : fontKey.split("\n"),
				variables: JSON.parse(variableKey) as VariableName[],
			}),
		[fontKey, variableKey],
	);
}

/**
 * What the width guide's switch stores.
 *
 * Words rather than `"true"` and `"false"`, because session storage holds strings and a stored
 * `"false"` reads as truthy to anything that forgets to compare it.
 */
const GUIDE_ON = "on";
const GUIDE_OFF = "off";

/**
 * How long a toolbar action keeps pulling focus back to the editor.
 *
 * Long enough to outlast a menu closing and returning focus to its trigger, short enough that it is
 * over before a person could deliberately click something else — a toolbar click and a considered
 * move to another control are not a third of a second apart.
 */
const FOCUS_GUARD_MS = 300;

/**
 * The paper's type size and line spacing, as numbers rather than as classes.
 *
 * A symbol is drawn as tall as the lines it was charged, which means the preview has to know its
 * own line height in pixels. Written here and applied as a style so that the height the text rows
 * are set at and the height the symbols are measured against are the same figure — a Tailwind class
 * beside a constant would be two figures, and a symbol would drift a fraction of a line off the
 * text the day either changed.
 */
const PAPER_FONT_SIZE_PX = 12;
const PAPER_LINE_HEIGHT = 1.45;
const PAPER_LINE_HEIGHT_PX = PAPER_FONT_SIZE_PX * PAPER_LINE_HEIGHT;

/**
 * How much of the row the editor may be dragged to take, as a percentage.
 *
 * Bounded at both ends rather than left free: the paper is a fixed number of columns wide and the
 * toolbar is a fixed number of buttons, so a handle dragged to either edge would hide one of them
 * behind a scrollbar with no way to see what happened.
 */
const SPLIT_MIN = 25;
const SPLIT_MAX = 75;

/** What one arrow key moves the handle, as a percentage. */
const SPLIT_STEP = 2;

/** Where the handle rests until it is moved, as a percentage. */
const SPLIT_DEFAULT = 50;

/** The handle's position, held inside its bounds and safe against a stored value that is not a number. */
function clampSplit(percent: number): number {
	if (!Number.isFinite(percent)) {
		return SPLIT_DEFAULT;
	}
	return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, percent));
}

/**
 * The picker's value for "whatever this printer is set to".
 *
 * A sentinel rather than an empty string, because an empty value is how a select says it has no
 * selection, and deferring to the device is a choice an operator makes on purpose.
 */
const DEVICE_DEFAULT = "device";

/** What the picker offers, and what each option is called. */
const LINEFEED_LABELS: Record<string, string> = {
	[DEVICE_DEFAULT]: "Default",
	LF: "LF",
	CRLF: "CRLF",
	NONE: "None",
};

/**
 * Reads the picker's value as a line ending the API will accept.
 *
 * Narrowed rather than cast: the value is restored from session storage, so it is whatever was
 * written there — including a value from an older build of this page. Anything the set does not
 * recognise falls back to the device's own setting, which is the safe answer.
 *
 * @param value the picker's current value
 * @returns the line ending, or null to defer to the device
 */
function chosenLinefeed(value: string): Linefeed | null {
	return Linefeed.is(value) ? value : null;
}

const SAMPLE = `<align to=center><bold>THE CORNER CAFE</bold></align>
<hr>
Coffee<fill>2.50
Pastry<fill>3.00
<hr>
<bold>Total<fill>5.50</bold>
<feed lines=3>
<cut>`;

/** A ready-made piece of markup the editor can be loaded with. */
interface Example {
	label: string;
	/** One line on what it demonstrates, shown beside the name. */
	note: string;
	/**
	 * Builds the markup for a printer.
	 *
	 * Takes the device rather than returning a constant because width and codepage belong in some
	 * of them — a ruler for a 32-column printer is wrong on a 42-column one, and silently so.
	 */
	build: (device: ToolDevice) => string;
}

/**
 * Characters the test page checks.
 *
 * The agent filters its own candidate list against the device's charset before printing, so its
 * page always prints. Nothing here can do that — the charset lives on the server — so this is a
 * fixed list of common Latin accents.
 *
 * A printer on a codepage that cannot carry one of them will report `unsupported_character` rather
 * than printing the page, and that is a true answer rather than a fault in the example: finding out
 * which characters a codepage refuses is most of what a test page is for. Two of the supported
 * codepages are Cyrillic, so there is no accented sample that would satisfy all of them anyway.
 */
const CODEPAGE_SAMPLE = "AaBb 123 .,:;!? #%&*()[] +-=/ ÄÖÜäöü ÉÑÇ éñç";

/**
 * What the test page's `<image>` names.
 *
 * The application's own logo, which ships *inside the agent* — dithered at each bundled paper
 * width by `pnpm agent:bundle-logo` and read from the jar by `BundledImages.java`. It is
 * deliberately not an asset: the Assets tab holds the operator's content, and a diagnostic that
 * breaks when someone tidies their library is a bad diagnostic. `"fenpos"` is a legal asset slug,
 * so what actually keeps an operator's own asset from colliding with it is `asset-service.ts`
 * refusing to let anything be created or imported under this exact name.
 *
 * **The panel resolves the same name from its own copy of the logo**, `public/fenpos-logo.png`,
 * through the same `ditherToRaster` that produced the agent's rasters — see
 * `lib/assets/bundled-logo.ts`, and `bundled-logo.test.ts` for the check that the two are the same
 * dots. So this previews and prints rather than reporting `unknown_asset`, which is what the
 * example needs: it exists to be held against the page the agent prints, and it could not be until
 * it rendered.
 *
 * **Only at a bundled width.** The agent matches a width exactly and never scales, so on a printer
 * whose full width is not 384, 504 or 576 dots this line is `unbundled_logo_width` — a refusal
 * naming the widths, rather than a preview of something no printer here could produce. Delete the
 * line to run the rest of the page on such a device.
 */
const BUNDLED_LOGO = "fenpos";

/**
 * A ruler marking every tenth column, so a wrong `columns` setting is visible rather than counted.
 *
 * Ported from `TestPage.java`'s `ruler`, and must stay identical to it: the point of loading the
 * test page here is to compare it against the one the agent prints.
 *
 * @param columns the printer's width
 * @returns a ruler exactly `columns` characters long
 */
function ruler(columns: number): string {
	let out = "";
	for (let column = 1; column <= columns; column++) {
		out += column % 10 === 0 ? String(Math.floor(column / 10) % 10) : column % 5 === 0 ? "+" : ".";
	}
	return out;
}

/**
 * What the Examples menu offers.
 *
 * Each is something an operator would otherwise type from memory or paste from a ticket. The test
 * page is the one that earns its place beyond convenience: it is the page the agent prints on
 * `device.test`, reproduced here so it can be edited, previewed and printed as a job — which the
 * agent's own version cannot be, because that one is composed on the agent and never passes
 * through the editor.
 *
 * **The test page must stay in step with `TestPage.java`, element for element**, because comparing
 * this preview against what the agent actually prints is the whole point of having it here. Two
 * differences are deliberate and are the only two: {@link CODEPAGE_SAMPLE}, which the agent filters
 * against the device's charset and this cannot, and {@link BUNDLED_LOGO}, which the agent omits on a
 * paper width it holds no raster for while this refuses the line instead. Both are documented where
 * they are written.
 */
const EXAMPLES: Example[] = [
	{
		label: "Café receipt",
		note: "Totals, rules and a cut",
		build: () => SAMPLE,
	},
	{
		label: "Device test page",
		note: "Width ruler, styles, codepage and blocks",
		build: (device) =>
			[
				"<align to=center><bold>FenPOS test page</bold></align>",
				"<hr>",
				`Device:   ${device.deviceName}`,
				`Columns:  ${device.columns}`,
				`Codepage: ${device.codepage}`,
				"<hr>",
				"Width ruler (should end exactly here):",
				ruler(device.columns),
				"<hr>",
				"<bold>bold</bold> <underline>underline</underline> <invert>invert</invert>",
				"<size width=2 height=2>Double</size>",
				"<align to=left>left</align>",
				"<align to=center>center</align>",
				"<align to=right>right</align>",
				"<hr>",
				"Codepage sample:",
				CODEPAGE_SAMPLE,
				"<hr>",
				"Blocks:",
				"<align to=center><qr>https://natroutter.fi</qr></align>",
				"<align to=center><barcode type=CODE39>FENPOS</barcode></align>",
				"<align to=center><pdf417>FENPOS TEST</pdf417></align>",
				`<align to=center><image>${BUNDLED_LOGO}</image></align>`,
				"<feed lines=3>",
				"<cut>",
			].join("\n"),
	},
	{
		label: "Wrapping",
		note: "The same line with and without <nowrap>",
		build: () =>
			[
				"<align to=center><bold>Wrapping</bold></align>",
				"<hr>",
				"<wrap>Wrapped at the last space that fits, which is what an operator asking to wrap wants.</wrap>",
				"<hr>",
				"<nowrap>Not wrapped by the server, so the printer runs out of paper and cuts mid-word.</nowrap>",
				"<feed lines=3>",
				"<cut>",
			].join("\n"),
	},
	{
		label: "Receipt with a QR code",
		note: "A symbol drawn at the height it prints",
		build: (device) =>
			[
				"<align to=center><bold>THE CORNER CAFE</bold></align>",
				"<hr>",
				"Coffee<fill>2.50",
				"Pastry<fill>3.00",
				"<hr>",
				"<bold>Total<fill>5.50</bold>",
				"<feed lines=1>",
				"<align to=center>Scan for the full receipt</align>",
				"<align to=center><qr>https://cafe.example/o/1042</qr></align>",
				`<align to=center>Printed on ${device.deviceName}</align>`,
				"<feed lines=3>",
				"<cut>",
			].join("\n"),
	},
	{
		label: "Kitchen order",
		note: "A docket, right-aligned quantities",
		build: () =>
			[
				"<align to=center><size width=2 height=2>TABLE 12</size></align>",
				"<hr>",
				"<bold>2x</bold> Salmon soup",
				"<bold>1x</bold> Veggie burger",
				"      - no onion",
				"<bold>3x</bold> Rye bread",
				"<hr>",
				"<align to=right>19:42</align>",
				"<feed lines=4>",
				"<cut>",
			].join("\n"),
	},
	{
		label: "Weather forecast",
		note: "A box, a plotted line and two grids",
		build: () =>
			[
				"<align to=center><size width=2 height=2>WEATHER</size></align>",
				"<align to=center>Wed, Sep 09 2026 . 08:00 . NEW YORK</align>",
				"<hr>",
				"<box border=single pad=1>",
				"  <align to=center><size width=2 height=2>68F</size></align>",
				"  <align to=center><bold>Partly cloudy</bold></align>",
				"  <align to=center>H 76F    L 62F</align>",
				"</box>",
				"<feed lines=1>",
				"<wrap>Next 24 hours: fair overall, between 62F and 76F, staying fairly steady. Little to no precipitation expected.</wrap>",
				"<feed lines=1>",
				"<bold>12-HOUR FORECAST</bold>",
				`<chart type=line height=9 title="Temperature (F)" legend=off>`,
				"  <series marker=circle>68,69,71,73,74,75,76,75,74,72,70,68</series>",
				"  <labels>08,09,10,11,12,13,14,15,16,17,18,19</labels>",
				"</chart>",
				"<feed lines=1>",
				"<bold>5-DAY FORECAST</bold>",
				"<table border=single>",
				"  <row>",
				"    <cell align=center><bold>Today</bold></cell>",
				"    <cell align=center><bold>Thu</bold></cell>",
				"    <cell align=center><bold>Fri</bold></cell>",
				"    <cell align=center><bold>Sat</bold></cell>",
				"    <cell align=center><bold>Sun</bold></cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center>09/09</cell>",
				"    <cell align=center>09/10</cell>",
				"    <cell align=center>09/11</cell>",
				"    <cell align=center>09/12</cell>",
				"    <cell align=center>09/13</cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center><bold>76</bold></cell>",
				"    <cell align=center><bold>74</bold></cell>",
				"    <cell align=center><bold>72</bold></cell>",
				"    <cell align=center><bold>75</bold></cell>",
				"    <cell align=center><bold>77</bold></cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center>62</cell>",
				"    <cell align=center>61</cell>",
				"    <cell align=center>60</cell>",
				"    <cell align=center>62</cell>",
				"    <cell align=center>64</cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center>10%</cell>",
				"    <cell align=center>5%</cell>",
				"    <cell align=center>60%</cell>",
				"    <cell align=center>15%</cell>",
				"    <cell align=center>5%</cell>",
				"  </row>",
				"</table>",
				"<align to=center>High / low / chance of rain</align>",
				"<feed lines=3>",
				"<cut>",
			].join("\n"),
	},
	{
		label: "Morning brief",
		note: "Headlines, rules and a QR code each",
		build: () =>
			[
				"<align to=center><size width=2 height=2>MORNING BRIEF</size></align>",
				"<align to=center>Wednesday, September 09, 2026 . 08:00</align>",
				"<hr>",
				"<bold>LOCAL</bold>",
				"<wrap><size width=2 height=2>Neighbourhood library opens a new reading garden</size></wrap>",
				"<wrap>A quiet outdoor space welcomes readers of all ages, open from sunrise until dusk.</wrap>",
				"<feed lines=1>",
				"<align to=center><qr size=4>https://news.example/a/1042</qr></align>",
				"<align to=center>Scan to read</align>",
				"<hr>",
				"<bold>MARKETS</bold>",
				"<wrap><size width=2 height=2>Weekend market returns to the town square</size></wrap>",
				"<wrap>Local growers and makers gather every Saturday from eight until two.</wrap>",
				"<feed lines=1>",
				"<align to=center><qr size=4>https://news.example/a/1043</qr></align>",
				"<align to=center>Scan to read</align>",
				"<hr>",
				"<bold>TRANSPORT</bold>",
				"<wrap><size width=2 height=2>Night bus adds two stops on the harbour route</size></wrap>",
				"<wrap>The 22 now calls at Pier Road and Old Customs House after ten in the evening.</wrap>",
				"<feed lines=1>",
				"<align to=center><qr size=4>https://news.example/a/1044</qr></align>",
				"<align to=center>Scan to read</align>",
				"<hr>",
				"<align to=center>Sample data. No wire service was harmed.</align>",
				"<feed lines=3>",
				"<cut>",
			].join("\n"),
	},
	{
		label: "Sudoku",
		note: "A 9x9 grid, ruled every third line",
		build: () =>
			[
				"<align to=center><size width=2 height=2>SUDOKU</size></align>",
				"<align to=center>Wednesday, September 09, 2026</align>",
				"<align to=center>Difficulty: medium</align>",
				"<hr>",
				"<table border=single group=3>",
				"  <row>",
				"    <cell align=center></cell>",
				"    <cell align=center>6</cell>",
				"    <cell align=center></cell>",
				"    <cell align=center>2</cell>",
				"    <cell align=center></cell>",
				"    <cell align=center>3</cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center>5</cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center></cell>",
				"    <cell align=center>5</cell>",
				"    <cell align=center></cell>",
				"    <cell align=center>6</cell>",
				"    <cell align=center>4</cell>",
				"    <cell align=center></cell>",
				"    <cell align=center>2</cell>",
				"    <cell align=center>1</cell>",
				"    <cell align=center>7</cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center>2</cell>",
				"    <cell align=center></cell>",
				"    <cell align=center>9</cell>",
				"    <cell align=center>7</cell>",
				"    <cell align=center>3</cell>",
				"    <cell align=center></cell>",
				"    <cell align=center>6</cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center>2</cell>",
				"    <cell align=center>9</cell>",
				"    <cell align=center>6</cell>",
				"    <cell align=center></cell>",
				"    <cell align=center>1</cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center>3</cell>",
				"    <cell align=center>8</cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center>4</cell>",
				"    <cell align=center></cell>",
				"    <cell align=center>6</cell>",
				"    <cell align=center>9</cell>",
				"    <cell align=center>7</cell>",
				"    <cell align=center></cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center>4</cell>",
				"    <cell align=center>1</cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center>6</cell>",
				"    <cell align=center></cell>",
				"    <cell align=center>5</cell>",
				"    <cell align=center>2</cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center>8</cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center>6</cell>",
				"    <cell align=center>4</cell>",
				"    <cell align=center>1</cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center>9</cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center>6</cell>",
				"    <cell align=center>4</cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center></cell>",
				"    <cell align=center>4</cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"    <cell align=center></cell>",
				"  </row>",
				"</table>",
				"<feed lines=1>",
				"<align to=center>One of each digit per row, column and box.</align>",
				"<feed lines=3>",
				"<cut>",
			].join("\n"),
	},
	{
		label: "Word search",
		note: "A letter grid and a wrapped word list",
		build: () =>
			[
				"<align to=center><size width=2 height=2>WORD SEARCH</size></align>",
				"<align to=center>Wednesday, September 09, 2026</align>",
				"<align to=center>Level: easy</align>",
				"<hr>",
				"<feed lines=1>",
				"<align to=center><bold>K B E N E V O L E N T O</bold></align>",
				"<align to=center><bold>K E U P H E M I S M G V</bold></align>",
				"<align to=center><bold>I J E S T U D I O A J X</bold></align>",
				"<align to=center><bold>V Q B D I C E E L T O N</bold></align>",
				"<align to=center><bold>Y R E S I L I E N C E H</bold></align>",
				"<align to=center><bold>Q O B N D S P C J A V A</bold></align>",
				"<align to=center><bold>L C N N C I P R H D W L</bold></align>",
				"<align to=center><bold>O Z I D H O E A O I K F</bold></align>",
				"<align to=center><bold>G K S C E M R U R X P T</bold></align>",
				"<align to=center><bold>I U R T U R Z E N A Y I</bold></align>",
				"<align to=center><bold>N A A L S E X T A N T M</bold></align>",
				"<align to=center><bold>E H P J N W A R D E N E</bold></align>",
				"<feed lines=1>",
				"<hr>",
				"<bold>FIND THESE WORDS</bold>",
				"<wrap>ARCHIPELAGO, BENEVOLENT, ENCORE, EUPHEMISM, HALFTIME, JEST, KINDLE, LOGIN, PLUME, PROXY, RESILIENCE, SEXTANT, STUDIO, WARDEN, YONDER</wrap>",
				"<feed lines=1>",
				"<align to=center>Across, down and diagonally.</align>",
				"<feed lines=3>",
				"<cut>",
			].join("\n"),
	},
	{
		label: "Crossword",
		note: "A grid of blocked squares, with clues",
		build: () =>
			[
				"<align to=center><size width=2 height=2>CROSSWORD</size></align>",
				"<align to=center>Wednesday, September 09, 2026</align>",
				"<align to=center>Level: easy</align>",
				"<hr>",
				"<table border=single>",
				"  <row>",
				"    <cell>1</cell>",
				"    <cell></cell>",
				"    <cell></cell>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell>2</cell>",
				"    <cell></cell>",
				"    <cell></cell>",
				"    <cell></cell>",
				"  </row>",
				"  <row>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"  </row>",
				"  <row>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"  </row>",
				"  <row>",
				"    <cell>3</cell>",
				"    <cell></cell>",
				"    <cell></cell>",
				"    <cell></cell>",
				"    <cell></cell>",
				"    <cell></cell>",
				"    <cell></cell>",
				"    <cell></cell>",
				"    <cell></cell>",
				"  </row>",
				"  <row>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"  </row>",
				"  <row>",
				"    <cell>4</cell>",
				"    <cell></cell>",
				"    <cell></cell>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"  </row>",
				"  <row>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell>5</cell>",
				"    <cell></cell>",
				"    <cell></cell>",
				"    <cell></cell>",
				"  </row>",
				"  <row>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"  </row>",
				"  <row>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"    <cell shade=black>.</cell>",
				"    <cell shade=black>.</cell>",
				"    <cell></cell>",
				"  </row>",
				"</table>",
				"<feed lines=1>",
				"<bold>ACROSS</bold>",
				"<wrap>1. A person new to a field or activity</wrap>",
				"<wrap>3. Series of rulers from one family</wrap>",
				"<wrap>4. Fire-breathing mythical winged reptile</wrap>",
				"<wrap>5. A group working toward a shared goal</wrap>",
				"<feed lines=1>",
				"<bold>DOWN</bold>",
				"<wrap>1. Sun-dried brick made of clay</wrap>",
				"<wrap>2. A mass of ice covering a region</wrap>",
				"<wrap>5. Facts and figures collected for analysis</wrap>",
				"<hr>",
				"<align to=center>Answers on the back of the roll.</align>",
				"<feed lines=3>",
				"<cut>",
			].join("\n"),
	},
	{
		label: "Maze",
		note: "Shaded cells drawn as walls",
		build: () =>
			[
				"<align to=center><size width=2 height=2>MAZE</size></align>",
				"<align to=center>Wednesday, September 09, 2026</align>",
				"<hr>",
				"<align to=center>Start top left, finish bottom right.</align>",
				"<feed lines=1>",
				"<table border=none>",
				"  <row>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"  </row>",
				"  <row>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"  </row>",
				"  <row>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"  </row>",
				"  <row>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"  </row>",
				"  <row>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"    <cell align=center>.</cell>",
				"  </row>",
				"  <row>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell shade=black></cell>",
				"    <cell align=center>.</cell>",
				"  </row>",
				"</table>",
				"<feed lines=1>",
				"<align to=center>Find the path.</align>",
				"<feed lines=3>",
				"<cut>",
			].join("\n"),
	},
	{
		label: "System monitor",
		note: "Gauges, a bar chart and leader lines",
		build: () =>
			[
				"<align to=center><size width=2 height=2>SYSTEM MONITOR</size></align>",
				"<align to=center>Wednesday, September 09, 2026 . 08:00</align>",
				"<hr>",
				"<bold>NETWORK</bold>",
				"Host<fill char=.>pc-1",
				"Address<fill char=.>192.0.2.10",
				"Wireless<fill char=.>Sample Home",
				"<hr>",
				"<bold>STORAGE</bold>",
				"<bar value=16>",
				"5GB used<fill char=.>27GB free",
				"<feed lines=1>",
				"<bold>MEMORY</bold>",
				"<bar value=38>",
				"192MB used<fill char=.>320MB free",
				"<hr>",
				`<chart type=bar height=7 title="CPU load, last six hours" legend=off>`,
				"  <series pattern=hatch>12,18,35,27,41,22</series>",
				"  <labels>02,03,04,05,06,07</labels>",
				"</chart>",
				"<hr>",
				"Uptime<fill char=.>2h 30m",
				"Load<fill char=.>0.12",
				"Temperature<fill char=.>42.5C",
				"<feed lines=3>",
				"<cut>",
			].join("\n"),
	},
	{
		label: "Day planner",
		note: "A week strip and the day's agenda",
		build: () =>
			[
				"<align to=center><size width=2 height=2>DAY PLANNER</size></align>",
				"<align to=center>Wednesday, September 09, 2026 . 08:00</align>",
				"<hr>",
				"<table border=single>",
				"  <row>",
				"    <cell align=center><bold>S</bold></cell>",
				"    <cell align=center><bold>M</bold></cell>",
				"    <cell align=center><bold>T</bold></cell>",
				"    <cell align=center><bold>W</bold></cell>",
				"    <cell align=center><bold>T</bold></cell>",
				"    <cell align=center><bold>F</bold></cell>",
				"    <cell align=center><bold>S</bold></cell>",
				"  </row>",
				"  <row>",
				"    <cell align=center>6</cell>",
				"    <cell align=center>7</cell>",
				"    <cell align=center>8</cell>",
				"    <cell align=center shade=light><bold>9</bold></cell>",
				"    <cell align=center>10</cell>",
				"    <cell align=center>11</cell>",
				"    <cell align=center>12</cell>",
				"  </row>",
				"</table>",
				"<hr>",
				"<bold>TODAY (09/09)</bold>",
				"09:30<fill char=.>Farmer's market run",
				"12:00<fill char=.>Lunch with Sam",
				"15:15<fill char=.>Dentist, Harbour Road",
				"<feed lines=1>",
				"<bold>TOMORROW (09/10)</bold>",
				"18:00<fill char=.>Grandma's birthday dinner",
				"<feed lines=1>",
				"<bold>SATURDAY (09/12)</bold>",
				"All day<fill char=.>Library pickup day",
				"<hr>",
				"<align to=center><qr size=4>https://calendar.example/d/20260909</qr></align>",
				"<align to=center>Scan for the full week</align>",
				"<feed lines=3>",
				"<cut>",
			].join("\n"),
	},
	{
		label: "Astronomy",
		note: "A plotted arc and a pie of the moon",
		build: () =>
			[
				"<align to=center><size width=2 height=2>ASTRONOMY</size></align>",
				"<align to=center>Wednesday, September 09, 2026 . 08:00</align>",
				"<align to=center>NEW YORK</align>",
				"<hr>",
				"<bold>SUN</bold>",
				`<chart type=line height=9 title="Altitude above the horizon" legend=off>`,
				"  <series marker=none>0,14,31,45,54,57,54,45,31,14,0</series>",
				"  <labels>06,08,09,11,12,13,15,16,18,19,20</labels>",
				"</chart>",
				"Sunrise<fill char=.>06:31",
				"Day length<fill char=.>12h 43m",
				"Sunset<fill char=.>19:14",
				"<hr>",
				"<bold>MOON</bold>",
				`<chart type=pie height=8 title="Illuminated" legend=on>`,
				"  <series>4,96</series>",
				"  <labels>Lit,Dark</labels>",
				"</chart>",
				"Phase<fill char=.>New",
				"Age<fill char=.>Day 27 of 28",
				"Next full<fill char=.>September 23",
				"<feed lines=3>",
				"<cut>",
			].join("\n"),
	},
];

/** One entry in a toolbar dropdown: what it writes, and how it is described. */
interface TagChoice {
	label: string;
	tag: string;
	attributes?: Record<string, string>;
	note?: string;
	/**
	 * Shown before the label, for the one or two entries worth picking out of the list at a glance.
	 *
	 * Not every entry carries one — most are read by their name — but a variable reference is not a
	 * tag at all, and the {@link Braces} icon is what the sidebar already uses for the tab that
	 * defines them, so the same icon here is what says "this leads somewhere else" before the
	 * description has to.
	 */
	icon?: ReactNode;
	/**
	 * Opens {@link InsertDialog} instead of writing the tag straight away.
	 *
	 * For the tags that are useless without something only the operator knows — which image, which
	 * symbology, what the barcode encodes. Writing `<barcode type=CODE128></barcode>` and leaving them
	 * to fill in the middle is worse than asking: it looks finished, and it compiles to a symbol with
	 * nothing in it.
	 */
	prompt?: InsertTag;
}

/**
 * Character multipliers offered as sizes.
 *
 * `<size>` takes `width` and `height`, which is two numbers most people do not want to think about.
 * These are the combinations worth a button — wider, taller, both — written the long way so the
 * markup a person ends up reading is the same shape whichever they picked.
 */
const SIZE_CHOICES: TagChoice[] = [
	{ label: "Double width", tag: "size", attributes: { width: "2" }, note: "<size width=2>" },
	{ label: "Double height", tag: "size", attributes: { height: "2" }, note: "<size height=2>" },
	{ label: "Double both", tag: "size", attributes: { width: "2", height: "2" }, note: "<size width=2 height=2>" },
	{ label: "Triple both", tag: "size", attributes: { width: "3", height: "3" }, note: "<size width=3 height=3>" },
];

/** Justification. Lowercase, matching how the examples and the docs write it. */
const ALIGN_CHOICES: TagChoice[] = [
	{ label: "Left", tag: "align", attributes: { to: "left" }, note: "<align to=left>" },
	{ label: "Centre", tag: "align", attributes: { to: "center" }, note: "<align to=center>" },
	{ label: "Right", tag: "align", attributes: { to: "right" }, note: "<align to=right>" },
];

/**
 * Everything that is inserted rather than wrapped around a selection.
 *
 * The void tags belong here because there is nothing to style with them, and the block tags belong
 * here because what they enclose is a payload rather than text — a button that wrapped the selected
 * words in `<qr>` would be reasonable only if those words were the thing to encode, which is the
 * less common case.
 *
 * Half of them go straight in; the other half open a dialog first, because they need a value the
 * toolbar has no way to guess. See {@link TagChoice.prompt}.
 *
 * Box, Table, Chart and Gauge belong here rather than in a menu of their own for the same reason as
 * the rest: none of them is a style applied to text, so there is nothing for a selection to carry
 * except, for Box alone, the lines it should frame. Font joined them too, once naming a stored font
 * meant asking for a size as well as a name — a single button could write `<text font=a>` or
 * `<text font=b>` without asking anything, but it cannot guess a name off the Assets tab.
 *
 * Box and Table were the last two written straight through, and what they wrote was an empty
 * structure: a frame that could not be given a width or a border, and a grid of two blank cells to be
 * copied by hand for a third. Both ask now.
 */
const INSERT_CHOICES: TagChoice[] = [
	{ label: "Horizontal rule", tag: "hr", note: "A full-width line" },
	{ label: "Fill", tag: "fill", prompt: "fill", note: "Pads out to the paper's width" },
	{ label: "Feed", tag: "feed", prompt: "feed", note: "Advance the paper" },
	{ label: "Cut", tag: "cut", note: "Cut the paper" },
	{ label: "Cash drawer", tag: "drawer", note: "Pulse the drawer" },
	{ label: "QR code", tag: "qr", prompt: "qr", note: "Choose what it encodes" },
	{ label: "Barcode", tag: "barcode", prompt: "barcode", note: "Choose a symbology and content" },
	{ label: "PDF417", tag: "pdf417", prompt: "pdf417", note: "Choose what it encodes" },
	{ label: "Image", tag: "image", prompt: "image", note: "Pick a stored image, or give a URL" },
	{
		label: "Variable",
		tag: "variable",
		prompt: "variable",
		note: "Pick a value defined on the Variables tab",
		icon: <Braces className="size-3.5" />,
	},
	{ label: "Wrap", tag: "wrap", note: "Break this line at the paper width" },
	{ label: "No wrap", tag: "nowrap", note: "Print this line as written" },
	{ label: "Box", tag: "box", prompt: "box", note: "Frame the selected lines" },
	{ label: "Table", tag: "table", prompt: "table", note: "Rows, columns and their cells" },
	{ label: "Chart", tag: "chart", prompt: "chart", note: "bar, line, pie or scatter" },
	{ label: "Gauge", tag: "bar", prompt: "bar", note: "0 to 100" },
	{ label: "Font", tag: "text", prompt: "text", note: "a, b or a stored font" },
];

/**
 * The markup editor, with a preview of the paper it would produce.
 *
 * **The preview is compiled by the server, through the same pipeline a real request takes.** A
 * preview built from a second implementation in the browser would agree with the real thing right
 * up until it mattered — a codepage rejection, a wrap at an unexpected column — and the entire
 * value of a preview is that what it shows is what will print.
 *
 * That costs a round trip per edit, which is why it is debounced rather than run on every
 * keystroke.
 */
export function MarkupTool({
	devices,
	fonts,
	variables,
	canPreview,
	canPrint,
}: {
	devices: ToolDevice[];
	/** Names of the fonts stored on the Assets tab, which is what a `<text font=…>` may name beyond
	    the printer's own two. Read on the server, because a client component cannot. */
	fonts: string[];
	/** The variables a `{name}` may refer to, for the editor to offer. Empty while the install has
	    variables switched off, since a brace is ordinary text then. */
	variables: VariableName[];
	/** Whether the operator holds `tools:preview`. Without it the paper card is left out and nothing
	    is compiled — the editor still composes markup, it just cannot be shown against the paper. */
	canPreview: boolean;
	/** Whether the operator holds `tools:print`. Takes the Print button and the line-ending picker
	    beside it, which is a choice about sending rather than about the markup. */
	canPrint: boolean;
}) {
	const [deviceId, setDeviceId] = useSessionState("tools.markup.device", devices[0]?.id ?? "");
	const [source, setSource] = useSessionState("tools.markup.source", SAMPLE);
	const [linefeed, setLinefeed] = useSessionState("tools.markup.linefeed", DEVICE_DEFAULT);
	const [result, setResult] = useState<PreviewResult | null>(null);
	const [compiling, startCompile] = useTransition();
	const [printing, startPrint] = useTransition();
	const editor = useRef<ReactCodeMirrorRef>(null);
	/** Which tag the insert dialog is collecting data for, or null when it is closed. */
	const [prompting, setPrompting] = useState<InsertTag | null>(null);
	/** The row the two panes sit in, which is what a drag measures a position against. */
	const splitRow = useRef<HTMLDivElement>(null);
	// Kept as text because that is what survives leaving the page; read back through `clampSplit`, so
	// a stored value from a build with different bounds — or none at all — still lands somewhere usable.
	const [storedSplit, setStoredSplit] = useSessionState("tools.markup.split", String(SPLIT_DEFAULT));
	// Off unless asked for, and remembered per session like the rest of this toolbar's state. The rule
	// measures source characters, so it only answers for plain text — see `printWidthGuide` — which is
	// a thing to reach for while laying out a table of prices, not to have standing there by default.
	const [guide, setGuide] = useSessionState("tools.markup.guide", GUIDE_OFF);
	const guideOn = guide === GUIDE_ON;
	const split = clampSplit(Number.parseFloat(storedSplit));
	const setSplit = useCallback((percent: number) => setStoredSplit(String(clampSplit(percent))), [setStoredSplit]);

	const device = devices.find((entry) => entry.id === deviceId);
	const extensions = useMarkupExtensions(fonts, variables);

	/**
	 * Writes a tag at the cursor, or around what is selected.
	 *
	 * Dispatched through CodeMirror rather than by rebuilding the string in React state, because the
	 * editor owns the selection and the undo history. Setting `source` directly would drop the caret
	 * to the end of the document and make the whole edit a single unattributed change; a transaction
	 * keeps the caret where {@link markupEdit} asked for it and leaves one Ctrl+Z between the person
	 * and their text.
	 *
	 * `changeByRange` applies the same edit to every cursor, so a multi-cursor selection styles each
	 * of its ranges rather than only the last.
	 *
	 * `name === "variable"` is the one case not dispatched to {@link markupEdit}: `{name}` is not a
	 * tag, so `tagByName` would find nothing and the insertion would silently do nothing. It goes to
	 * {@link variableEdit} instead, which places the caret the same way a void tag's insertion does.
	 *
	 * @param name the tag to write, or `"variable"` to insert `{content}` as a variable reference
	 * @param attributes its attributes, for tags that take them
	 * @param content what it should enclose, when that came from a dialog rather than from the
	 *   selection — the two are alternatives, and a dialog's answer wins because the person just
	 *   typed it. An empty answer is no answer: a dialog that collects attributes alone, as `<box>`'s
	 *   does, hands back nothing to enclose, and the selection is what the tag goes around. For
	 *   `"variable"`, this is the variable's name rather than enclosed text.
	 * @param data the structure a dialog filled in, for `<chart>` and `<table>`
	 */
	const applyTag = useCallback(
		(name: string, attributes?: Record<string, string>, content?: string, data?: InsertData) => {
			const view = editor.current?.view;
			if (!view) {
				return;
			}

			const { state } = view;
			view.dispatch(
				state.update(
					state.changeByRange((range) => {
						const selected = state.sliceDoc(range.from, range.to);
						const edit =
							name === "variable" && content !== undefined
								? variableEdit(content, selected)
								: markupEdit(name, content === undefined || content === "" ? selected : content, attributes, data);
						if (!edit) {
							return { range };
						}

						return {
							changes: { from: range.from, to: range.to, insert: edit.insert },
							range: EditorSelection.range(range.from + edit.selectionFrom, range.from + edit.selectionTo),
						};
					}),
					{ userEvent: "input", scrollIntoView: true },
				),
			);
			// Back to the editor, and then held there. The click moved focus to a button, and the point of
			// putting the caret between the tags is that the next thing typed lands there.
			//
			// The toolbar's four menus make this harder than it looks. An open menu keeps focus inside
			// itself, so a `focus()` from an item's click handler is taken straight back; the item then
			// unmounts as the menu closes, dropping focus to `<body>`; and the menu may hand focus to its
			// own trigger button on the way out. Each of those happens at a moment this code cannot
			// predict, and counting animation frames to outlast them encodes a duration that goes wrong
			// the day the animation changes.
			//
			// So rather than guessing when, watch for it: while the menu is closing, any focus landing
			// outside the editor is the menu tidying up after itself, and the caret this function just
			// placed between two tags is what the person is about to type into. Pull it back, briefly, and
			// stop watching once things have settled.
			view.focus();

			const keepFocus = (event: FocusEvent): void => {
				if (!(event.target instanceof Node) || !view.dom.contains(event.target)) {
					view.focus();
				}
			};
			document.addEventListener("focusin", keepFocus, true);
			window.setTimeout(() => document.removeEventListener("focusin", keepFocus, true), FOCUS_GUARD_MS);
		},
		[],
	);

	useEffect(() => {
		// `canPreview` here as well as at the card: without it every keystroke would spend a round
		// trip on a compile that comes back refused.
		if (!deviceId || !canPreview) {
			return;
		}
		const timer = setTimeout(() => {
			startCompile(async () => setResult(await preview(deviceId, source, chosenLinefeed(linefeed))));
		}, DEBOUNCE_MS);
		return () => clearTimeout(timer);
		// `linefeed` is a dependency even though it cannot change the paper — it changes the bytes,
		// not the layout. Without it the footer went on reporting whichever ending was in force when
		// the markup last changed, which is worse than not stating it at all.
	}, [deviceId, source, linefeed, canPreview]);

	// Underlines what the compile refused, where it happened. Keyed on the errors alone rather than on
	// the whole result: a preview that comes back clean after one that did not still has to clear the
	// markers, and one that comes back with the same faults should not redraw them.
	const errors = result?.errors;
	useEffect(() => {
		const view = editor.current?.view;
		if (view) {
			showMarkupErrors(view, errors ?? []);
		}
	}, [errors]);

	// Where the paper ends, when the guide is switched on and a printer has said how wide it is.
	// Zero covers both halves of "not now": the switch is off, or no device is chosen and there is no
	// width to draw — the same answer, and the guide draws nothing for it.
	const guideColumns = guideOn ? (device?.columns ?? 0) : 0;
	useEffect(() => {
		const view = editor.current?.view;
		if (view) {
			showPrintWidth(view, guideColumns);
		}
	}, [guideColumns]);

	if (devices.length === 0) {
		return (
			<Card>
				<CardContent className="py-8 text-center text-[12.5px] text-subtle-foreground">
					No printers configured. Add one on the Devices tab to use this.
				</CardContent>
			</Card>
		);
	}

	return (
		// One card holding both panes, rather than two cards side by side, with a handle between them:
		// the markup and the paper it produces are one task, and where the line between them falls
		// depends on what is being written — a fixed half and half is right for nobody in particular.
		//
		// The card is as tall as the window from `lg` up, and each pane scrolls inside itself. Left to
		// its content it grew as tall as the markup was long, so editing the end of a long receipt
		// scrolled the paper off the top of the window and every change meant scrolling back up to see
		// what it did. Below `lg` the panes stack and the card takes its content's height again: a
		// split row on a narrow screen leaves two columns too thin to read either of them.
		<Card className="flex flex-col lg:h-[calc(100svh-10.5rem)] lg:min-h-[34rem]">
			{/* `relative`, because the handle is laid over the seam rather than set into the row. A
			    handle that took width of its own opened a gap the whole height of the card, and across
			    the header band that gap showed as a notch of card colour cut out of the band. The panes
			    meet instead, the seam is the left pane's own right border, and the handle floats on it. */}
			<div ref={splitRow} className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
				{/* The basis is set from the handle rather than from a class, and only from `lg`, where
				    the row is a row. In the stacked layout a basis is a height, and giving the editor
				    half the card's height there would cut the toolbar in two. With no preview there is
				    nothing to divide, so the editor takes the row rather than half of it. */}
				<section
					className={`flex min-h-0 min-w-0 flex-col ${canPreview ? "lg:basis-(--split) lg:border-border lg:border-r" : "flex-1"}`}
					style={canPreview ? ({ "--split": `${split}%` } as CSSProperties) : undefined}
				>
					<CardHeader className="flex flex-row flex-wrap items-center gap-3 rounded-none border-b border-border pb-3">
						<Code className="size-4.5 shrink-0 text-subtle-foreground" />
						<div className="min-w-0 flex-1">
							<h3 className="text-[13px] font-medium">Markup</h3>
							<p className="mt-0.5 text-[11.5px] text-muted-foreground">
								One line per element of <span className="font-mono">data</span>. Tags are listed on the Docs tab.
							</p>
						</div>
						<DevicePicker devices={devices} value={deviceId} onChange={setDeviceId} />
					</CardHeader>
					<CardContent className="flex min-h-0 flex-1 flex-col gap-3 pt-4">
						{/* A menu of actions rather than a select: loading an example is something you do,
					    not a value the editor holds — a select would go on claiming an example was
					    "selected" after the first keystroke changed it into something else. */}
						<div className="flex flex-wrap items-center gap-2">
							{/* The three that need no attributes get a button each; everything else is a menu,
						    because a tag with a value has no single obvious one to put on a button. */}
							<div className="flex items-center gap-1">
								<TagButton label="Bold" icon={<Bold className="size-3.5" />} onClick={() => applyTag("bold")} />
								<TagButton
									label="Underline"
									icon={<Underline className="size-3.5" />}
									onClick={() => applyTag("underline")}
								/>
								<TagButton label="Invert" icon={<Contrast className="size-3.5" />} onClick={() => applyTag("invert")} />
							</div>

							<TagMenu
								label="Size"
								icon={<ALargeSmall className="size-3.5" />}
								choices={SIZE_CHOICES}
								onPick={applyTag}
							/>
							<TagMenu
								label="Align"
								icon={<AlignCenter className="size-3.5" />}
								choices={ALIGN_CHOICES}
								onPick={applyTag}
							/>
							<TagMenu
								label="Insert"
								icon={<Plus className="size-3.5" />}
								choices={INSERT_CHOICES}
								onPick={applyTag}
								onPrompt={setPrompting}
							/>

							<span aria-hidden className="h-5 w-px bg-border" />

							<Button
								type="button"
								variant="outline"
								size="sm"
								className="h-7 text-[11.5px]"
								disabled={source.trim() === ""}
								onClick={() => setSource("")}
							>
								<Eraser className="size-3.5" />
								Clear
							</Button>

							{/* A switch rather than a menu item: it is a thing the editor is either doing or
						    not, and the button says which by looking pressed. Disabled with no printer
						    chosen, since the width it would stand at is the printer's answer. `title` carries
						    what the rule actually measures — the toolbar has no room to say it, and a guide
						    that quietly means something narrower than it looks is worth one sentence. */}
							<Button
								type="button"
								variant={guideOn ? "secondary" : "outline"}
								size="sm"
								className="h-7 text-[11.5px]"
								aria-pressed={guideOn}
								disabled={!device}
								title={
									device
										? `Marks ${device.columns} characters of plain text. Tags are counted as the characters they are written with, so a line carrying them reaches the rule sooner than it fills the paper.`
										: "Choose a printer to mark where its paper ends."
								}
								onClick={() => setGuide(guideOn ? GUIDE_OFF : GUIDE_ON)}
							>
								<Ruler className="size-3.5" />
								Width guide
							</Button>

							<DropdownMenu>
								<DropdownMenuTrigger
									render={<Button type="button" variant="outline" size="sm" className="h-7 text-[11.5px]" />}
									disabled={!device}
								>
									<BookOpen className="size-3.5" />
									Examples
									<ChevronDown className="size-3.5 opacity-60" />
								</DropdownMenuTrigger>
								<DropdownMenuContent className="w-auto min-w-72">
									{EXAMPLES.map((example) => (
										<DropdownMenuItem
											key={example.label}
											className="flex-col items-start gap-0.5 text-[12.5px]"
											onClick={() => device && setSource(example.build(device))}
										>
											<span>{example.label}</span>
											<span className="text-[11px] text-subtle-foreground">{example.note}</span>
										</DropdownMenuItem>
									))}
								</DropdownMenuContent>
							</DropdownMenu>

							<span className="text-[11px] text-subtle-foreground">Examples replace the editor; undo with Ctrl+Z.</span>
						</div>

						{/* No border of its own: the editor's background is transparent, so it sits directly
					    in the card's well. A frame here would draw a second box inside the card.

					    `flex-1` with `height="100%"`: the editor takes what is left of the pane once the
					    toolbar and the controls under it have had theirs, and scrolls its own markup
					    inside that. `min-h-80` is the floor in the stacked layout, where the card has no
					    height of its own; from `lg` the card's height is the window's and the editor
					    must be free to shrink to whatever share of it the handle has left. */}
						<div className="min-h-80 flex-1 overflow-hidden lg:min-h-0">
							<CodeMirror
								ref={editor}
								value={source}
								// `className` lands on the component's own `.cm-theme` wrapper, which has no
								// height of its own — so the editor's `height="100%"` resolved against `auto`
								// and came back to its content. Both are needed.
								className="h-full"
								height="100%"
								theme={editorTheme}
								extensions={extensions}
								basicSetup={{
									lineNumbers: true,
									foldGutter: false,
									highlightActiveLine: false,
									// Off: it marks every other occurrence of whatever is selected, which in a
									// buffer of repeated sequences and repeated tags reads as the selection having
									// jumped to lines nobody selected.
									highlightSelectionMatches: false,
								}}
								onChange={setSource}
							/>
						</div>

						{/* Mounted here rather than behind each menu item: a menu item cannot also be a dialog
					    trigger, because choosing it closes the menu that owns it. The toolbar records which
					    tag was asked for and this reads that. */}
						<InsertDialog tag={prompting} fonts={fonts} onClose={() => setPrompting(null)} onInsert={applyTag} />

						{/* A rule inside the content rather than a filled footer band, matching how the
					    other tabs' cards separate their controls from what they act on. The whole row
					    goes with the Print button: the line ending is a choice about sending, so on its
					    own it would be a control over nothing. */}
						{!canPrint ? null : (
							<CardActions className="min-h-17">
								<LinefeedPicker value={linefeed} onChange={setLinefeed} />

								<div className="flex-1" />

								<Button
									type="button"
									disabled={printing || !device}
									onClick={() =>
										startPrint(async () => {
											const outcome = await printMarkup(deviceId, source, chosenLinefeed(linefeed));
											if (outcome.error) {
												toast.error(outcome.error);
											} else {
												toast.success(outcome.message ?? "Queued.");
											}
										})
									}
								>
									{printing ? <Spinner className="size-3.5" /> : <Printer className="size-3.5" />}
									Print
								</Button>
							</CardActions>
						)}
					</CardContent>
				</section>

				{!canPreview ? null : <Splitter value={split} onChange={setSplit} rowRef={splitRow} />}

				{!canPreview ? null : (
					<section className="flex min-h-0 min-w-0 flex-1 flex-col">
						<CardHeader className="flex flex-row items-center gap-3 rounded-none border-b border-border pb-3">
							<ReceiptText className="size-4.5 shrink-0 text-subtle-foreground" />
							<div className="min-w-0 flex-1">
								<h3 className="text-[13px] font-medium">Paper preview</h3>
								<p className="mt-0.5 text-[11.5px] text-muted-foreground">
									Compiled by the server, at this printer's own width and codepage.
								</p>
							</div>
							{/* The measurements sit with the verdict below, beside what they describe.
					    Repeating them here would state the same numbers twice. */}
							{compiling ? <Spinner className="size-3.5" /> : null}
						</CardHeader>
						<CardContent className="flex min-h-0 flex-1 flex-col pt-4">
							{result && result.errors.length > 0 ? <Problems errors={result.errors} /> : <Paper result={result} />}

							{/* Only when it compiles. A failing preview already says everything there is to say
					    where the paper would have been, and a second verdict under it would be one
					    judgement too many on the same markup. */}
							{result && result.errors.length === 0 && result.lines ? (
								// A column, so `justify-center` is what centres it the way `items-center` centres
								// the single-row cases. Without it the two lines sat at the top of the row.
								<CardActions className="min-h-17 flex-col items-start justify-center gap-1">
									<div className="flex items-center gap-2">
										<CircleCheck className="size-4 shrink-0 text-emerald-400" />
										<span className="text-[12.5px] font-medium">Compiles clean</span>
									</div>
									<p className="text-[11.5px] text-muted-foreground">
										{result.outputLines} output {result.outputLines === 1 ? "line" : "lines"} of {result.maxOutputLines}{" "}
										· {result.columns} columns · linefeed {result.linefeed}
									</p>
								</CardActions>
							) : null}
						</CardContent>
					</section>
				)}
			</div>
		</Card>
	);
}

/**
 * The handle between the markup and the paper.
 *
 * A separator carrying a value rather than a plain rule, because it is a control: it can be tabbed
 * to and moved with the arrow keys, which is the only way to reach it without a pointer. Home and a
 * double-click both return it to the middle, which is faster than dragging back to a half nobody can
 * hit exactly.
 *
 * The pointer is captured on the way down, so a drag that runs over the editor keeps being reported
 * here rather than being swallowed by whatever it passes over. Positions are measured against the
 * row rather than accumulated from movements, so a drag that outruns the pointer's own events lands
 * where the pointer is rather than a little behind it.
 *
 * Hidden below `lg`, where the panes stack: there is nothing to divide horizontally, and a handle
 * that resized nothing would still take a tab stop.
 *
 * @param rowRef the row the panes sit in, which a drag measures a position against and which the
 *   handle is positioned inside — it has to be the positioned ancestor for that to line up
 */
function Splitter({
	value,
	onChange,
	rowRef,
}: {
	value: number;
	onChange: (percent: number) => void;
	rowRef: RefObject<HTMLDivElement | null>;
}) {
	const dragging = useRef(false);

	const moveTo = (clientX: number): void => {
		const row = rowRef.current;
		if (!row) {
			return;
		}
		const bounds = row.getBoundingClientRect();
		if (bounds.width === 0) {
			return;
		}
		onChange(((clientX - bounds.left) / bounds.width) * 100);
	};

	return (
		// An `<hr>`, which is a separator already, rather than a div told to be one.
		//
		// Laid over the seam rather than set into the row: it is positioned at the handle's own
		// percentage and pulled back by half its width, so its middle sits on the border the panes
		// already draw between them. Taking width of its own would part the panes by nine pixels and
		// cut a notch of card colour out of the header band where it crossed.
		//
		// It is transparent until it is pointed at. The one pixel of colour that appears then is the
		// padding box; the four transparent pixels of border either side are what makes it something a
		// pointer can hit at all. `bg-clip-padding` keeps that colour off the border, and `box-content`
		// keeps the border outside the pixel rather than eating it.
		//
		// `touch-none`: without it a drag on a touch screen scrolls the panel instead of moving the
		// handle, and the browser takes the pointer away mid-gesture.
		<hr
			aria-orientation="vertical"
			aria-label="Resize the markup pane"
			aria-valuenow={Math.round(value)}
			aria-valuemin={SPLIT_MIN}
			aria-valuemax={SPLIT_MAX}
			tabIndex={0}
			style={{ left: `${value}%` }}
			className="absolute inset-y-0 z-10 my-0 box-content hidden h-auto w-px -translate-x-1/2 cursor-col-resize touch-none border-transparent border-x-4 border-y-0 bg-transparent bg-clip-padding outline-none transition-colors hover:bg-brand focus-visible:bg-brand lg:block"
			onPointerDown={(event) => {
				dragging.current = true;
				event.currentTarget.setPointerCapture(event.pointerId);
				// Stops the drag from selecting the text either side of the handle as it passes over it.
				event.preventDefault();
				event.currentTarget.focus();
			}}
			onPointerMove={(event) => {
				if (dragging.current) {
					moveTo(event.clientX);
				}
			}}
			onPointerUp={(event) => {
				dragging.current = false;
				event.currentTarget.releasePointerCapture(event.pointerId);
			}}
			onPointerCancel={() => {
				dragging.current = false;
			}}
			onDoubleClick={() => onChange(SPLIT_DEFAULT)}
			onKeyDown={(event) => {
				if (event.key === "ArrowLeft") {
					event.preventDefault();
					onChange(value - SPLIT_STEP);
				} else if (event.key === "ArrowRight") {
					event.preventDefault();
					onChange(value + SPLIT_STEP);
				} else if (event.key === "Home") {
					event.preventDefault();
					onChange(SPLIT_DEFAULT);
				}
			}}
		/>
	);
}

/**
 * Everything wrong with the markup, in the place the paper would have been.
 *
 * Where the paper goes rather than in a footer, because there is no paper: the card's job is to
 * show what this markup produces, and what it produces is a `400`. Putting the failure somewhere
 * else would leave the card's main area empty and make the operator hunt for the reason.
 *
 * Every error, not the first. The server checks each element independently for exactly this, so an
 * operator with four typos fixes four typos rather than discovering them one round trip at a time.
 *
 * Position and code are set in monospace and column-aligned: they are strings from the API, and a
 * ragged list of them is much harder to scan than an aligned one when there are several.
 */
/**
 * One icon-only toolbar button.
 *
 * `title` as well as `aria-label`: the icon alone does not say what `<invert>` is, and this toolbar
 * is used by people who have not read the tag list. A tooltip component would look better and would
 * need a provider around the tree for the sake of three buttons.
 */
function TagButton({ label, icon, onClick }: { label: string; icon: ReactNode; onClick: () => void }) {
	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			className="size-7 p-0"
			aria-label={label}
			title={label}
			onClick={onClick}
		>
			{icon}
		</Button>
	);
}

/**
 * A toolbar dropdown for one family of tags.
 *
 * Each item shows the markup it writes beneath its name. The toolbar is a shortcut, not a
 * replacement for knowing the language — someone who has used it a few times should be able to type
 * the tag themselves, and they cannot learn it from a button that hides what it did.
 */
function TagMenu({
	label,
	icon,
	choices,
	onPick,
	onPrompt,
}: {
	label: string;
	icon: ReactNode;
	choices: TagChoice[];
	/** Called for a choice that writes its tag straight away. */
	onPick: (tag: string, attributes?: Record<string, string>) => void;
	/** Called instead for a choice that needs the dialog to collect something first. */
	onPrompt?: (prompt: InsertTag) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<Button type="button" variant="outline" size="sm" className="h-7 text-[11.5px]" />}>
				{icon}
				{label}
				<ChevronDown className="size-3.5 opacity-60" />
			</DropdownMenuTrigger>
			{/* `finalFocus={false}`: the menu would otherwise put focus back on its own trigger button
			    when it closes, undoing the editor focus that `applyTag` restores and stranding the
			    caret it just placed between two tags. Nothing here needs focus afterwards — the editor
			    does. */}
			<DropdownMenuContent className="w-auto min-w-52" finalFocus={false}>
				{choices.map((choice) => (
					<DropdownMenuItem
						key={choice.label}
						className="flex-col items-start gap-0.5 text-[12.5px]"
						onClick={() =>
							choice.prompt && onPrompt ? onPrompt(choice.prompt) : onPick(choice.tag, choice.attributes)
						}
					>
						<span className="flex items-center gap-1.5">
							{choice.icon}
							{choice.label}
						</span>
						{choice.note ? <span className="font-mono text-[11px] text-subtle-foreground">{choice.note}</span> : null}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function Problems({ errors }: { errors: PreviewError[] }) {
	// Every element error is a 400. Taking the status from the first rather than hardcoding it
	// keeps this honest if a request-level failure with a different status ever lands here.
	const status = errors[0]?.status ?? 400;

	return (
		// `min-h-0` with `overflow-y-auto`: the pane's height is the window's, so a list long enough to
		// outgrow it scrolls inside the panel rather than pushing the verdict row off the card.
		<div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-destructive/30 bg-destructive/5 p-4">
			<div className="flex items-center gap-2">
				<CircleAlert className="size-4 shrink-0 text-destructive" />
				<span className="text-[12.5px] font-medium text-destructive">
					{errors.length} error{errors.length === 1 ? "" : "s"} — {status}, nothing queued
				</span>
			</div>

			<div className="mt-3 grid grid-cols-[auto_auto_1fr] gap-x-6 gap-y-1.5">
				{errors.map((error, index) => (
					<Fragment key={`${error.code}:${error.line}:${error.column}:${index}`}>
						<span className="font-mono text-[11.5px] text-destructive">
							{error.line === null ? "request" : `line ${error.line}${error.column === null ? "" : `:${error.column}`}`}
						</span>
						<span className="font-mono text-[11.5px] font-medium">{error.code}</span>
						<span className="text-[11.5px] text-muted-foreground">{error.message}</span>
					</Fragment>
				))}
			</div>

			<p className="mt-3 text-[11px] text-subtle-foreground">
				Line and column are 1-based, exactly as the API reports them.
			</p>
		</div>
	);
}

/**
 * Chooses what terminates each printed line, for this print only.
 *
 * Sits beside Print rather than in the header, because it is part of sending rather than part of
 * composing: nothing about it changes the markup or the paper the preview draws. It changes the
 * bytes, and the bytes are what the button sends.
 *
 * Defaults to the device's own setting, which is the right answer almost always. It is here at all
 * because a printer that ignores the configured ending is the kind of fault you diagnose by trying
 * the other two, and doing that by editing the device and coming back is a slow way to answer a
 * quick question.
 */
function LinefeedPicker({ value, onChange }: { value: string; onChange: (next: string) => void }) {
	return (
		<div className="flex flex-col gap-1">
			<span className="text-[11px] text-subtle-foreground">Line ending</span>
			<Select items={LINEFEED_LABELS} value={value} onValueChange={(next) => next && onChange(next)}>
				<SelectTrigger className="h-8 w-auto min-w-[130px] font-mono text-[12px]">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{Object.entries(LINEFEED_LABELS).map(([key, label]) => (
						<SelectItem key={key} value={key} className="font-mono text-[12px]">
							{label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/**
 * The compiled lines, drawn at the device's width.
 *
 * **The paper is exactly `columns` characters wide, in `ch` units.** It used to be
 * `width: fit-content` with `minWidth: 100%`, which stretched the sheet to whatever the card
 * happened to be — so a centred total sat in the middle of the browser window rather than the
 * middle of 32 columns of thermal paper, and the preview disagreed with the printer for the one
 * reason a preview exists. A `ch` is the advance width of a digit in the element's own font, and
 * the font is monospace, so `columns` of them is the sheet.
 *
 * Directives that print nothing are drawn as a marker rather than as blank paper, so a cut is
 * visible where it will happen. A symbol is drawn as the symbol it is, occupying the lines the
 * compiler charged for it: a QR code that pushes a receipt past its line limit takes up as much of
 * the sheet here as it will there.
 */
function Paper({ result }: { result: PreviewResult | null }) {
	if (!result?.lines) {
		return <p className="flex-1 text-[12px] text-subtle-foreground">Type something to see it laid out.</p>;
	}

	return (
		// The sheet is the paper, so it is exactly `columns` wide and no wider, and it sits in the
		// middle of the card the way a receipt sits in the middle of a desk. Scrolling and padding
		// belong to the outer track: padding on the sheet would be inside its width and leave it a
		// character or two short of the printer's line.
		// `flex-1` on the track, never on the sheet: the track is the desk and may grow to fill the
		// card, while the sheet is the paper and stays exactly `columns` wide whatever happens
		// around it. Stretching the sheet would make the preview disagree with the printer, which
		// is the one thing a preview may not do.
		// `overflow-auto` rather than `overflow-x-auto`, with `min-h-0`: the desk is as tall as the
		// pane, and a receipt longer than that scrolls on the desk. Letting it grow instead would push
		// the verdict row below the card and take the paper's own top off the window.
		<div className="min-h-0 flex-1 overflow-auto rounded-md p-4">
			<div
				className="mx-auto w-fit rounded-sm bg-white px-3 py-3 shadow-sm ring-1 ring-black/10"
				style={{ minWidth: "fit-content" }}
			>
				<div
					className="font-mono text-black"
					style={{
						width: `${result.columns}ch`,
						fontSize: `${PAPER_FONT_SIZE_PX}px`,
						lineHeight: PAPER_LINE_HEIGHT,
					}}
				>
					{result.lines.length === 0 ? (
						<span className="text-neutral-400">(nothing to print)</span>
					) : (
						result.lines.flatMap((line, index) => {
							const rows: ReactNode[] = [];

							// Blocks first, because a block takes its element alone: nothing else on this
							// line can print beside one, and only a drawer pulse can accompany it at all.
							for (const [blockIndex, block] of line.blocks.entries()) {
								rows.push(
									<div key={`${lineKey(index, line)}:block:${blockIndex}`} style={{ textAlign: align(line.align) }}>
										{/* All three arrive finished — an SVG for a symbol, the printer's own dots
										    as a PNG for an image or a drawn line — and differ only in how they are
										    placed on the paper. A drawn line has no reference of its own to show, so
										    it is labelled by what it is instead of by what it was written as. */}
										{block.kind === "SYMBOL" ? (
											<SymbolPreview
												spec={block.spec}
												svg={block.svg}
												heightLines={block.heightLines}
												widthFraction={block.widthFraction}
												lineHeightPx={PAPER_LINE_HEIGHT_PX}
											/>
										) : (
											<ImagePreview
												reference={block.kind === "IMAGE" ? block.ref : "drawn"}
												png={block.png}
												heightLines={block.heightLines}
												inkedLines={block.inkedLines}
												widthFraction={block.widthFraction}
												lineHeightPx={PAPER_LINE_HEIGHT_PX}
											/>
										)}
									</div>,
								);

								// A backstop that should no longer fire. The compiler refuses a symbol wider
								// than the paper outright — `symbol_too_wide` — so a preview carrying lines
								// at all has already passed that check, and an image's width is a percentage
								// of the paper with the tag stopping at a hundred. It stays because a symbol
								// drawn clamped to the sheet would otherwise look like it fits, and the one
								// thing a preview may not do is make an unprintable receipt look printable.
								// It was once the *only* thing standing between an over-wide symbol and a
								// job; it under-reported Code 128 by 43% while it held that job, which is
								// why the refusal now lives in the compiler instead.
								if (block.widthFraction > 1) {
									rows.push(
										<Marker
											key={`${lineKey(index, line)}:block:${blockIndex}:overflow`}
											align={line.align}
											text={`${Math.round(block.widthFraction * 100)}% of the paper's width — too wide to print`}
										/>,
									);
								}
							}

							// One compiled line can occupy several lines of paper. The server breaks lines it
							// was asked to wrap; a `<nowrap>` line reaches the printer whole, and the printer
							// runs out of paper and continues on the next line — cutting mid-word at the
							// column count, not at a space. Drawing that is the only way the preview matches
							// what comes out.
							if (line.spans.some((span) => span.text.length > 0)) {
								rows.push(
									...toPaperRows(line, result.columns).map((row, rowIndex) => (
										<div
											key={`${lineKey(index, line)}:${rowIndex}`}
											className="whitespace-pre"
											style={{ textAlign: align(line.align) }}
										>
											{row.map((span, spanIndex) => (
												<span
													key={`${index}:${rowIndex}:${spanIndex}:${span.text}`}
													style={{
														fontWeight: span.bold ? 700 : 400,
														textDecoration: span.underline > 0 ? "underline" : undefined,
														// A double-width character occupies two columns on paper, so it must occupy
														// two here. In `ch` that is exact; the old `0.6em` was a guess that drifted
														// further from the truth the longer the span.
														letterSpacing: span.widthMult > 1 ? `${span.widthMult - 1}ch` : undefined,
														// Letter spacing is added after the last character too, which would push
														// everything after it — and shift a centred line — by a column it does not
														// occupy on paper.
														marginInlineEnd: span.widthMult > 1 ? `${-(span.widthMult - 1)}ch` : undefined,
														backgroundColor: span.invert ? "black" : undefined,
														color: span.invert ? "white" : undefined,
													}}
												>
													{span.text}
												</span>
											))}
										</div>
									)),
								);
							}

							// Under whatever printed, because a cut, a feed or a drawer pulse happens after
							// the line it was written on. It marks paper the printer never inks, so it is
							// drawn in grey and costs the receipt nothing.
							if (line.marker) {
								rows.push(<Marker key={`${lineKey(index, line)}:marker`} align={line.align} text={line.marker} />);
							}

							// An element that produced nothing at all is still a line of blank paper, and an
							// empty div would collapse to no height rather than showing it.
							if (rows.length === 0) {
								rows.push(
									<div key={`${lineKey(index, line)}:blank`} className="whitespace-pre">
										{" "}
									</div>,
								);
							}

							return rows;
						})
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * Something true about a line that the paper itself does not say.
 *
 * Grey and ruled off, because none of it is ink: a cut, a feed and a drawer pulse leave no mark,
 * and neither does the note that a symbol is too wide to print. Sharing one register is what keeps
 * "this is about the paper rather than on it" readable at a glance.
 */
function Marker({ text, align: alignment }: { text: string; align: PreviewLine["align"] }) {
	return (
		<div className="whitespace-pre" style={{ textAlign: align(alignment) }}>
			<span className="text-neutral-400">{`── ${text} ──`}</span>
		</div>
	);
}

/**
 * Splits a compiled line into the lines of paper it will actually occupy.
 *
 * A line the server wrapped already fits, and comes back as a single row. A `<nowrap>` line does
 * not: it reaches the printer whole, the printer prints until it runs out of paper and continues
 * the remainder on the next line, cutting at the column count rather than at a word boundary. The
 * preview has to do the same or it disagrees with the paper on the one case the tag exists for.
 *
 * **This is a hard break, deliberately.** It is not the wrapper's job — `wrapper.ts` breaks at the
 * last space that fits, because that is what an operator asking to wrap wants. This is a machine
 * running out of room, and it does not look for spaces.
 *
 * Spans are split rather than kept whole, so a break falling inside a bold run leaves both halves
 * bold. Width is counted in columns, not characters: a double-width character consumes two, and a
 * character that will not fit in the columns left is pushed to the next row rather than half-drawn.
 *
 * @param line the compiled line
 * @param columns the printer's width
 * @returns one array of spans per line of paper, never empty
 */
function toPaperRows(line: PreviewLine, columns: number): PreviewLine["spans"][] {
	const rows: PreviewLine["spans"][] = [];
	let row: PreviewLine["spans"] = [];
	let used = 0;

	const flush = (): void => {
		rows.push(row);
		row = [];
		used = 0;
	};

	for (const span of line.spans) {
		let rest = span.text;

		while (rest.length > 0) {
			// At least one character when the row is empty, so a character wider than the whole
			// paper still makes progress instead of looping forever.
			const fits = Math.max(used === 0 ? 1 : 0, Math.floor((columns - used) / span.widthMult));
			if (fits === 0) {
				flush();
				continue;
			}

			const take = rest.slice(0, fits);
			row.push({ ...span, text: take });
			used += take.length * span.widthMult;
			rest = rest.slice(take.length);

			if (used >= columns) {
				flush();
			}
		}
	}

	if (row.length > 0 || rows.length === 0) {
		flush();
	}

	return rows;
}

/**
 * Builds a stable key for a printed line.
 *
 * Position alone is not enough — React would reuse a row when the text above it changed length —
 * and printed lines carry no identity of their own, so the key is position plus what is on it.
 */
function lineKey(index: number, line: PreviewLine): string {
	const content = [
		...line.blocks.map((block) =>
			block.kind === "SYMBOL" ? block.spec.content : block.kind === "IMAGE" ? block.ref : block.png,
		),
		...line.spans.map((span) => span.text),
		line.marker ?? "",
	].join("");
	return `${index}:${content}`;
}

function align(value: "LEFT" | "CENTER" | "RIGHT"): "left" | "center" | "right" {
	return value === "CENTER" ? "center" : value === "RIGHT" ? "right" : "left";
}
