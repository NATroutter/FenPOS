"use client";

import CodeMirror from "@uiw/react-codemirror";
import { BookOpen, ChevronDown, CircleAlert, CircleCheck, Code, Eraser, Printer, ReceiptText } from "lucide-react";
import { Fragment, useEffect, useState, useTransition } from "react";
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
import { useSessionState } from "@/components/panel/session-state";
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

/** How long the editor sits still before a preview is compiled. */
const DEBOUNCE_MS = 300;

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

const SAMPLE = `<align=center><bold>THE CORNER CAFE</bold></align>
<hr>
Coffee           2.50
Pastry           3.00
<hr>
<bold>Total            5.50</bold>
<feed=3>
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
 */
const EXAMPLES: Example[] = [
	{
		label: "Café receipt",
		note: "Totals, rules and a cut",
		build: () => SAMPLE,
	},
	{
		label: "Device test page",
		note: "Width ruler, styles and codepage",
		build: (device) =>
			[
				"<align=center><bold>FenPOS test page</bold></align>",
				"<hr>",
				`Device:   ${device.deviceName}`,
				`Columns:  ${device.columns}`,
				`Codepage: ${device.codepage}`,
				"<hr>",
				"Width ruler (should end exactly here):",
				ruler(device.columns),
				"<hr>",
				"<bold>bold</bold> <underline>underline</underline> <invert>invert</invert>",
				"<size=2,2>Double</size>",
				"<align=left>left</align>",
				"<align=center>center</align>",
				"<align=right>right</align>",
				"<hr>",
				"Codepage sample:",
				CODEPAGE_SAMPLE,
				"<feed=3>",
				"<cut>",
			].join("\n"),
	},
	{
		label: "Wrapping",
		note: "The same line with and without <nowrap>",
		build: () =>
			[
				"<align=center><bold>Wrapping</bold></align>",
				"<hr>",
				"<wrap>Wrapped at the last space that fits, which is what an operator asking to wrap wants.</wrap>",
				"<hr>",
				"<nowrap>Not wrapped by the server, so the printer runs out of paper and cuts mid-word.</nowrap>",
				"<feed=3>",
				"<cut>",
			].join("\n"),
	},
	{
		label: "Kitchen order",
		note: "A docket, right-aligned quantities",
		build: () =>
			[
				"<align=center><size=2,2>TABLE 12</size></align>",
				"<hr>",
				"<bold>2x</bold> Salmon soup",
				"<bold>1x</bold> Veggie burger",
				"      - no onion",
				"<bold>3x</bold> Rye bread",
				"<hr>",
				"<align=right>19:42</align>",
				"<feed=4>",
				"<cut>",
			].join("\n"),
	},
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
export function MarkupTool({ devices }: { devices: ToolDevice[] }) {
	const [deviceId, setDeviceId] = useSessionState("tools.markup.device", devices[0]?.id ?? "");
	const [source, setSource] = useSessionState("tools.markup.source", SAMPLE);
	const [linefeed, setLinefeed] = useSessionState("tools.markup.linefeed", DEVICE_DEFAULT);
	const [result, setResult] = useState<PreviewResult | null>(null);
	const [compiling, startCompile] = useTransition();
	const [printing, startPrint] = useTransition();

	const device = devices.find((entry) => entry.id === deviceId);

	useEffect(() => {
		if (!deviceId) {
			return;
		}
		const timer = setTimeout(() => {
			startCompile(async () => setResult(await preview(deviceId, source, chosenLinefeed(linefeed))));
		}, DEBOUNCE_MS);
		return () => clearTimeout(timer);
		// `linefeed` is a dependency even though it cannot change the paper — it changes the bytes,
		// not the layout. Without it the footer went on reporting whichever ending was in force when
		// the markup last changed, which is worse than not stating it at all.
	}, [deviceId, source, linefeed]);

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
		// No `items-start`: the two cards stretch to the taller of them, so the preview's paper is
		// as tall as the editor beside it rather than stopping halfway up the row.
		<div className="grid gap-4 lg:grid-cols-2">
			<Card className="flex flex-col">
				<CardHeader className="flex flex-row flex-wrap items-center gap-3 border-b border-border pb-3">
					<Code className="size-4.5 shrink-0 text-subtle-foreground" />
					<div className="min-w-0 flex-1">
						<h3 className="text-[13px] font-medium">Markup</h3>
						<p className="mt-0.5 text-[11.5px] text-muted-foreground">
							One line per element of <span className="font-mono">data</span>. Tags are listed on the Docs tab.
						</p>
					</div>
					<DevicePicker devices={devices} value={deviceId} onChange={setDeviceId} />
				</CardHeader>
				<CardContent className="flex flex-1 flex-col gap-3 pt-4">
					{/* A menu of actions rather than a select: loading an example is something you do,
					    not a value the editor holds — a select would go on claiming an example was
					    "selected" after the first keystroke changed it into something else. */}
					<div className="flex flex-wrap items-center gap-2">
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

						<span className="text-[11px] text-subtle-foreground">Replaces the editor; undo with Ctrl+Z.</span>
					</div>

					{/* No border of its own: the editor's background is transparent, so it sits directly
					    in the card's well. A frame here would draw a second box inside the card.

					    `flex-1` with `height="100%"`: this card's height is set by the preview beside it,
					    which is as tall as the receipt is long. A fixed 320px editor left the rest of
					    the card empty and scrolled the markup inside a box with space underneath it.
					    `min-h-80` keeps 320px as the floor for when the preview is shorter than that. */}
					<div className="min-h-80 flex-1 overflow-hidden">
						<CodeMirror
							value={source}
							// `className` lands on the component's own `.cm-theme` wrapper, which has no
							// height of its own — so the editor's `height="100%"` resolved against `auto`
							// and came back to its content. Both are needed.
							className="h-full"
							height="100%"
							theme={editorTheme}
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

					{/* A rule inside the content rather than a filled footer band, matching how the
					    other tabs' cards separate their controls from what they act on. */}
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
				</CardContent>
			</Card>

			<Card className="flex flex-col">
				<CardHeader className="flex flex-row items-center gap-3 border-b border-border pb-3">
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
				<CardContent className="flex flex-1 flex-col pt-4">
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
								{result.outputLines} output {result.outputLines === 1 ? "line" : "lines"} of {result.maxOutputLines} ·{" "}
								{result.columns} columns · linefeed {result.linefeed}
							</p>
						</CardActions>
					) : null}
				</CardContent>
			</Card>
		</div>
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
function Problems({ errors }: { errors: PreviewError[] }) {
	// Every element error is a 400. Taking the status from the first rather than hardcoding it
	// keeps this honest if a request-level failure with a different status ever lands here.
	const status = errors[0]?.status ?? 400;

	return (
		<div className="flex-1 rounded-md border border-destructive/30 bg-destructive/5 p-4">
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
 * Directive-only lines are drawn as a marker rather than as blank paper, so a cut is visible
 * where it will happen.
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
		<div className="flex-1 overflow-x-auto rounded-md p-4">
			<div
				className="mx-auto w-fit rounded-sm bg-white px-3 py-3 shadow-sm ring-1 ring-black/10"
				style={{ minWidth: "fit-content" }}
			>
				<div className="font-mono text-[12px] leading-[1.45] text-black" style={{ width: `${result.columns}ch` }}>
					{result.lines.length === 0 ? (
						<span className="text-neutral-400">(nothing to print)</span>
					) : (
						result.lines.flatMap((line, index) => {
							if (line.marker) {
								return (
									<div key={lineKey(index, line)} className="whitespace-pre" style={{ textAlign: align(line.align) }}>
										<span className="text-neutral-400">{`── ${line.marker} ──`}</span>
									</div>
								);
							}

							if (line.spans.length === 0) {
								return (
									<div key={lineKey(index, line)} className="whitespace-pre">
										{" "}
									</div>
								);
							}

							// One compiled line can occupy several lines of paper. The server breaks lines it
							// was asked to wrap; a `<nowrap>` line reaches the printer whole, and the printer
							// runs out of paper and continues on the next line — cutting mid-word at the
							// column count, not at a space. Drawing that is the only way the preview matches
							// what comes out.
							return toPaperRows(line, result.columns).map((row, rowIndex) => (
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
							));
						})
					)}
				</div>
			</div>
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
	const content = line.marker ?? line.spans.map((span) => span.text).join("");
	return `${index}:${content}`;
}

function align(value: "LEFT" | "CENTER" | "RIGHT"): "left" | "center" | "right" {
	return value === "CENTER" ? "center" : value === "RIGHT" ? "right" : "left";
}
