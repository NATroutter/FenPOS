"use client";

import CodeMirror from "@uiw/react-codemirror";
import { Binary, BookOpen, ChevronDown, Eraser, ListTree, Send } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { writeRaw } from "@/app/(panel)/tools/actions";
import { DevicePicker, type ToolDevice } from "@/app/(panel)/tools/device-picker";
import { editorTheme } from "@/app/(panel)/tools/editor-theme";
import { useSessionState } from "@/components/panel/session-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardActions, CardContent, CardHeader } from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

/**
 * Ready-made sequences the editor can be loaded with.
 *
 * Each is a whole small job rather than a single command — the single commands are what the
 * Sequences list beside the editor is for. These are the errands that come up on their own: prove
 * the printer responds, make the drawer fire, see what the codepage does.
 */
const RAW_EXAMPLES: { label: string; note: string; lines: string[] }[] = [
	{
		label: "Reset and cut",
		note: "Initialise, feed clear, full cut",
		lines: ["1B 40           # initialise", "1B 64 03        # feed 3 lines", "1D 56 00        # full cut"],
	},
	{
		label: "Open cash drawer",
		note: "Pulse pin 2, then pin 5",
		lines: [
			"1B 40           # initialise",
			"1B 70 00 19 FA  # open drawer, pin 2",
			"1B 70 01 19 FA  # open drawer, pin 5",
		],
	},
	{
		label: "Status query",
		note: "Ask the printer to report on the port",
		lines: [
			"10 04 01        # printer status",
			"10 04 02        # offline status",
			"10 04 03        # error status",
			"10 04 04        # paper sensor",
		],
	},
	{
		label: "Codepage switch",
		note: "Select PC437, then PC850",
		lines: ["1B 40           # initialise", "1B 74 00        # codepage pc437", "1B 74 02        # codepage pc850"],
	},
];

/** The bytes the editor opens with, taken from the first example so the two cannot disagree. */
const RAW_SAMPLE = RAW_EXAMPLES[0].lines.join("\n");

/** One ESC/POS sequence, as the picker offers it. */
interface Snippet {
	/** What the sequence does, in the operator's words. */
	label: string;
	/** The bytes, in the same hexadecimal the editor accepts. */
	bytes: string;
	/** The mnemonic from the ESC/POS command set, for looking the sequence up in a manual. */
	mnemonic: string;
}

/**
 * The sequences worth having to hand, grouped by what they are for.
 *
 * Grouped rather than listed because a flat row of names is only navigable while it is short, and
 * the useful set is not short. The groups match how the command set itself is organised, so an
 * operator who knows ESC/POS finds things where they expect them and one who does not can read the
 * group name instead.
 *
 * **Not exhaustive, and deliberately so.** These are the commands that are the same across the
 * printers this runs on. Anything model-specific belongs in that model's manual, not in a list that
 * would be quietly wrong for half the estate.
 */
const SNIPPET_GROUPS: { group: string; snippets: Snippet[] }[] = [
	{
		group: "Setup",
		snippets: [
			{ label: "Initialise", bytes: "1B 40", mnemonic: "ESC @" },
			{ label: "Codepage PC437", bytes: "1B 74 00", mnemonic: "ESC t 0" },
			{ label: "Codepage PC850", bytes: "1B 74 02", mnemonic: "ESC t 2" },
		],
	},
	{
		group: "Alignment",
		snippets: [
			{ label: "Align left", bytes: "1B 61 00", mnemonic: "ESC a 0" },
			{ label: "Align centre", bytes: "1B 61 01", mnemonic: "ESC a 1" },
			{ label: "Align right", bytes: "1B 61 02", mnemonic: "ESC a 2" },
		],
	},
	{
		group: "Text style",
		snippets: [
			{ label: "Bold on", bytes: "1B 45 01", mnemonic: "ESC E 1" },
			{ label: "Bold off", bytes: "1B 45 00", mnemonic: "ESC E 0" },
			{ label: "Underline on", bytes: "1B 2D 01", mnemonic: "ESC - 1" },
			{ label: "Underline off", bytes: "1B 2D 00", mnemonic: "ESC - 0" },
			{ label: "Double size", bytes: "1D 21 11", mnemonic: "GS ! 17" },
			{ label: "Normal size", bytes: "1D 21 00", mnemonic: "GS ! 0" },
			{ label: "Invert on", bytes: "1D 42 01", mnemonic: "GS B 1" },
			{ label: "Invert off", bytes: "1D 42 00", mnemonic: "GS B 0" },
		],
	},
	{
		group: "Feeding",
		snippets: [
			{ label: "Feed 1 line", bytes: "0A", mnemonic: "LF" },
			{ label: "Feed 3 lines", bytes: "1B 64 03", mnemonic: "ESC d 3" },
			{ label: "Feed 6 lines", bytes: "1B 64 06", mnemonic: "ESC d 6" },
			{ label: "Feed 100 dots", bytes: "1B 4A 64", mnemonic: "ESC J 100" },
		],
	},
	{
		group: "Cutting",
		snippets: [
			{ label: "Full cut", bytes: "1D 56 00", mnemonic: "GS V 0" },
			{ label: "Partial cut", bytes: "1D 56 01", mnemonic: "GS V 1" },
			{ label: "Feed then partial cut", bytes: "1D 56 42 03", mnemonic: "GS V 66 3" },
		],
	},
	{
		group: "Cash drawer",
		snippets: [
			{ label: "Open drawer, pin 2", bytes: "1B 70 00 19 FA", mnemonic: "ESC p 0" },
			{ label: "Open drawer, pin 5", bytes: "1B 70 01 19 FA", mnemonic: "ESC p 1" },
		],
	},
	{
		group: "Status",
		snippets: [
			{ label: "Printer status", bytes: "10 04 01", mnemonic: "DLE EOT 1" },
			{ label: "Offline status", bytes: "10 04 02", mnemonic: "DLE EOT 2" },
			{ label: "Error status", bytes: "10 04 03", mnemonic: "DLE EOT 3" },
			{ label: "Paper sensor", bytes: "10 04 04", mnemonic: "DLE EOT 4" },
		],
	},
];

/**
 * The raw byte editor.
 *
 * **This hands arbitrary bytes to hardware.** It answers to the panel session alone: `writeRaw`
 * checks no permission and no install setting, only that a session is open. That is only as strong
 * as "there is only one account" — true of every install today, since `setup.ts` is the only place
 * a user is created — and it stops being true the moment a later phase adds a second one; `tools:raw`
 * is already reserved in Phase 3's permission set against that day. A machine client reaches the
 * same act through `POST /devices/{agent}/{device}/raw`, which is gated twice over — a key must hold
 * `devices:raw` *and* the install must have `link.allowRawApiWrites` switched on, which it does not
 * by default. Every write is logged twice — here and on the agent — because two records on two
 * machines is what makes it auditable if either is later in question.
 *
 * Bytes are written in hexadecimal rather than as text. A text field would invite pasting a
 * receipt into it, and the difference between "print this" and "execute this" is the difference
 * between a receipt and a printer that needs a power cycle.
 */
export function RawTool({ devices }: { devices: ToolDevice[] }) {
	const [deviceId, setDeviceId] = useSessionState("tools.raw.device", devices[0]?.id ?? "");
	const [source, setSource] = useSessionState("tools.raw.source", RAW_SAMPLE);
	const [pending, startTransition] = useTransition();

	const device = devices.find((entry) => entry.id === deviceId);
	const parsed = parseHex(source);

	if (devices.length === 0) {
		return null;
	}

	return (
		// Two cards rather than one, matching Markup and Paper preview above: what you are writing
		// on the left, what you can draw on to write it on the right. The sequences used to be
		// behind a dropdown, which meant opening a menu, hunting through seven groups and closing it
		// again for every single insertion — and inserting several in a row is the normal case.
		<div className="grid gap-4 lg:grid-cols-2">
			<Card className="flex flex-col">
				<CardHeader className="flex flex-row flex-wrap items-center gap-3 border-b border-border pb-3">
					<Binary className="size-4.5 shrink-0 text-subtle-foreground" />
					<div className="min-w-0 flex-1">
						<h3 className="text-[13px] font-medium">Raw bytes</h3>
						<p className="mt-0.5 text-[11.5px] text-muted-foreground">
							Written to the port unmodified, bypassing the queue. Admins send from here; an API key needs the raw-write
							permission and the install switch under Settings → Security.
						</p>
					</div>
					<DevicePicker devices={devices} value={deviceId} onChange={setDeviceId} />
				</CardHeader>

				<CardContent className="flex flex-1 flex-col gap-3 pt-4">
					{/* Above the editor, where Markup keeps its own Clear: it acts on what you are about
					    to write rather than on sending it, so it does not belong beside Send. */}
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
							>
								<BookOpen className="size-3.5" />
								Examples
								<ChevronDown className="size-3.5 opacity-60" />
							</DropdownMenuTrigger>
							<DropdownMenuContent className="w-auto min-w-72">
								{RAW_EXAMPLES.map((example) => (
									<DropdownMenuItem
										key={example.label}
										className="flex-col items-start gap-0.5 text-[12.5px]"
										onClick={() => setSource(example.lines.join("\n"))}
									>
										<span>{example.label}</span>
										<span className="text-[11px] text-subtle-foreground">{example.note}</span>
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>

						<span className="text-[11px] text-subtle-foreground">Replaces the editor; undo with Ctrl+Z.</span>
					</div>

					{/* No border of its own: the editor is transparent and sits in the card's well. */}
					<div className="overflow-hidden">
						<CodeMirror
							value={source}
							height="320px"
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

					{parsed.error ? (
						<Alert variant="destructive">
							<AlertDescription>{parsed.error}</AlertDescription>
						</Alert>
					) : null}

					{/* A rule inside the content rather than a filled footer band, matching how the
					    other tabs' cards separate their controls from what they act on. */}
					<CardActions className="min-h-17">
						{/* On the left of the row rather than alone under the editor, where it read as a
						    stray caption. It describes what Send will do, so it belongs beside Send. */}
						<span className="text-[11.5px] text-subtle-foreground">
							{parsed.bytes.length} {parsed.bytes.length === 1 ? "byte" : "bytes"}. Hexadecimal, whitespace and{" "}
							<span className="font-mono">#</span> comments ignored.
						</span>

						<div className="flex-1" />

						{device && !device.online ? (
							<span className="text-[11.5px] text-subtle-foreground">That agent is offline.</span>
						) : null}

						<Button
							type="button"
							variant="outline"
							className="border-destructive/40 text-destructive hover:bg-destructive/10"
							disabled={pending || parsed.error !== null || parsed.bytes.length === 0 || !device?.online}
							onClick={() =>
								startTransition(async () => {
									const outcome = await writeRaw(deviceId, parsed.bytes);
									if (outcome.error) {
										toast.error(outcome.error);
									} else {
										toast.success(outcome.message ?? "Sent.");
									}
								})
							}
						>
							{pending ? <Spinner className="size-3.5" /> : <Send className="size-3.5" />}
							Send
						</Button>
					</CardActions>
				</CardContent>
			</Card>

			{/* The card is taken out of flow at `lg`, where the two sit side by side, so that its 27
			    rows do not decide how tall the row is. A grid row is as tall as its tallest item's
			    content, and this list's content is much taller than the editor's — left in flow it
			    stretched both cards to 1162px. Out of flow it contributes nothing, the row is sized
			    by the editor alone, and the card fills whatever that turns out to be.

			    Below `lg` the cards stack, there is no neighbour to match, and the card is an
			    ordinary block that sizes itself. */}
			<div className="relative min-h-[28rem] lg:min-h-0">
				<SequenceList onInsert={(snippet) => setSource((current) => append(current, snippet))} />
			</div>
		</div>
	);
}

/**
 * The sequences, as a list you can read and click.
 *
 * A list rather than a menu. Inserting one sequence from a dropdown is fine; inserting six in a row
 * — which is what building a test slip actually looks like — means opening and closing that menu
 * six times, and hunting through seven collapsed groups on every pass. Laid out flat, the whole set
 * is visible at once and each insertion is a single click.
 *
 * The filter matches the name, the mnemonic and the bytes, because an operator arrives here from
 * three different directions: knowing what they want to do, remembering `GS V`, or having read
 * `1D 56 00` off a manual and wanting to know what it is.
 *
 * @param onInsert called with the sequence a row was clicked for
 */
function SequenceList({ onInsert }: { onInsert: (snippet: Snippet) => void }) {
	// Deliberately not persisted, unlike the editor's contents: a filter describes what you are
	// looking for right now, and coming back to a list that is still hiding most of itself reads
	// as a list that has lost its entries.
	const [filter, setFilter] = useState("");

	const matching = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		if (needle === "") {
			return SNIPPET_GROUPS;
		}
		return SNIPPET_GROUPS.map((entry) => ({
			group: entry.group,
			snippets: entry.snippets.filter((snippet) =>
				`${snippet.label} ${snippet.mnemonic} ${snippet.bytes}`.toLowerCase().includes(needle),
			),
		})).filter((entry) => entry.snippets.length > 0);
	}, [filter]);

	return (
		<Card className="flex min-h-0 flex-col lg:absolute lg:inset-0">
			<CardHeader className="flex flex-row items-center gap-3 border-b border-border pb-3">
				<ListTree className="size-4.5 shrink-0 text-subtle-foreground" />
				<div className="min-w-0 flex-1">
					<h3 className="text-[13px] font-medium">Sequences</h3>
					<p className="mt-0.5 text-[11.5px] text-muted-foreground">
						Click to append one to the editor, labelled with what it does.
					</p>
				</div>
			</CardHeader>

			<CardContent className="flex min-h-0 flex-1 flex-col gap-3 pt-4">
				<Input
					value={filter}
					placeholder="Filter by name, mnemonic or bytes"
					className="h-8 text-[12px]"
					onChange={(event) => setFilter(event.target.value)}
				/>

				{matching.length === 0 ? (
					<p className="py-6 text-center text-[12px] text-subtle-foreground">Nothing matches “{filter.trim()}”.</p>
				) : (
					// `min-h-0` is what makes this scroll rather than stretch. A flex or grid child
					// defaults to `min-height: auto`, which refuses to shrink below its content — so
					// without it the list grew the card to fit all 27 rows. With the whole chain from
					// the card down set to 0, this card's minimum height is nothing, the grid row is
					// sized by the editor beside it, and the list fills exactly what is left.
					//
					// A fixed `max-h` did the scrolling but not the filling: it stopped 100px short of
					// a card whose height is set by its neighbour, leaving a gap under the list.
					<div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
						{matching.map((entry) => (
							<div key={entry.group}>
								<div className="px-2 pt-2 pb-1 text-[11px] font-medium text-subtle-foreground">{entry.group}</div>
								{entry.snippets.map((snippet) => (
									<button
										key={snippet.label}
										type="button"
										title={snippet.mnemonic}
										className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
										onClick={() => onInsert(snippet)}
									>
										<span className="min-w-0 flex-1 truncate text-[12.5px]">{snippet.label}</span>
										<span className="shrink-0 font-mono text-[11px] text-subtle-foreground">{snippet.bytes}</span>
									</button>
								))}
							</div>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

/** Width the bytes are padded to, so the trailing comments line up into a column. */
const COMMENT_COLUMN = 16;

/**
 * Adds a snippet to the end of the buffer, labelled.
 *
 * The label is written as a `#` comment, which the parser discards. Bytes on their own are
 * unreadable a minute after they were inserted — `1D 56 42 03` says nothing about being a cut —
 * and a buffer nobody can read is one that gets sent to a printer on faith.
 *
 * @param current the buffer as it stands
 * @param snippet the sequence to add
 * @returns the buffer with the snippet on a line of its own
 */
function append(current: string, snippet: Snippet): string {
	const line = `${snippet.bytes.padEnd(COMMENT_COLUMN)}# ${snippet.label.toLowerCase()}`;
	return current.trim() === "" ? line : `${current.replace(/\n+$/, "")}\n${line}`;
}

/**
 * Reads hexadecimal byte pairs, ignoring whitespace and comments.
 *
 * Refuses anything it does not understand rather than skipping it. A tolerant parser here would
 * silently drop a byte from a control sequence, and a control sequence missing a byte is how a
 * printer ends up in a state nobody can explain.
 *
 * @param source the editor's contents
 * @returns the bytes, or the first thing that was not one
 */
function parseHex(source: string): { bytes: number[]; error: string | null } {
	const bytes: number[] = [];

	for (const rawLine of source.split("\n")) {
		const line = rawLine.split("#")[0].trim();
		if (line === "") {
			continue;
		}
		for (const token of line.split(/[\s,]+/)) {
			if (token === "") {
				continue;
			}
			const cleaned = token.replace(/^0x/i, "");
			if (!/^[0-9a-f]{1,2}$/i.test(cleaned)) {
				return { bytes: [], error: `'${token}' is not a hexadecimal byte.` };
			}
			bytes.push(Number.parseInt(cleaned, 16));
		}
	}

	return { bytes, error: null };
}
