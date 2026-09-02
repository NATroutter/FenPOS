"use client";

import { X } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A list edited as badges rather than as punctuation.
 *
 * **The comma was the whole problem.** A list in a text box asks somebody to get separators right
 * in a field that gives no sign whether they did: a stray comma makes an empty entry, a missing one
 * silently fuses two values into a third that matches nothing, and neither shows up until the thing
 * the list configures quietly stops working. Here an entry either exists as a badge or it does not,
 * and the separator is a keystroke rather than a character in the value.
 *
 * Enter, space and comma all commit — three keys because three different habits arrive at this
 * control and being wrong about which costs a confused retype. Backspace on an empty box removes
 * the last badge, which is the behaviour every other token field has taught people to expect.
 *
 * The value crossing in and out is still the joined string the setting stores, so nothing about the
 * storage format changes and this is a rendering of a `list` setting rather than a new shape.
 */

/** Keys that end an entry. Comma is included because it is what the stored value uses. */
const COMMIT_KEYS = new Set(["Enter", " ", ","]);

export function BadgeInput({
	values,
	onChange,
	disabled = false,
	placeholder,
	label,
	/**
	 * Whether an entry is acceptable. A rejected one stays in the box as text rather than becoming a
	 * badge, so the operator sees what was wrong with it instead of having it silently dropped.
	 */
	accepts,
	/**
	 * Entries offered as one-click additions under the box.
	 *
	 * Only the ones not already added are shown, so the row is always a list of things clicking will
	 * actually do — and removing a badge brings its suggestion back, which is what makes trying a
	 * different header a pair of clicks rather than a retype.
	 */
	suggestions = [],
}: {
	values: string[];
	onChange: (next: string[]) => void;
	disabled?: boolean;
	placeholder?: string;
	/** Names the inner box for a screen reader, which has no label of its own to read. */
	label: string;
	accepts?: (entry: string) => boolean;
	suggestions?: readonly string[];
}) {
	const [draft, setDraft] = useState("");
	const [refused, setRefused] = useState(false);
	const box = useRef<HTMLInputElement>(null);

	/**
	 * Takes what is typed and turns it into badges.
	 *
	 * Several at once, because a pasted list is the other way entries arrive here and splitting it
	 * is the difference between paste working and paste producing one badge with commas in it.
	 *
	 * @param text one or more entries, however they were separated
	 * @returns whether everything in it was accepted
	 */
	const commit = (text: string): boolean => {
		const entries = text
			.split(/[,\s\n]+/)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);

		if (entries.length === 0) {
			return true;
		}

		const usable = entries.filter((entry) => accepts === undefined || accepts(entry));
		// Case-insensitively, because these are header names: adding `X-Forwarded-For` beside an
		// existing `x-forwarded-for` would be one header listed twice and a second chance at nothing.
		const seen = new Set(values.map((value) => value.toLowerCase()));
		const added = usable.filter((entry) => {
			const key = entry.toLowerCase();
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});

		if (added.length > 0) {
			onChange([...values, ...added]);
		}
		return usable.length === entries.length;
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
		if (COMMIT_KEYS.has(event.key)) {
			// Always prevented, including for a space: this box holds entries that never contain one,
			// and a space that inserted itself would sit invisibly at the end of a badge nobody could
			// see was wrong.
			event.preventDefault();
			if (draft.trim() === "") {
				return;
			}
			if (commit(draft)) {
				setDraft("");
				setRefused(false);
			} else {
				setRefused(true);
			}
			return;
		}

		// Only on an empty box, so backspace still edits the word being typed. This is the one
		// destructive key here with no confirmation, which is why it takes the last badge rather than
		// the one under some notion of a cursor — the last is the one just added.
		if (event.key === "Backspace" && draft === "" && values.length > 0) {
			event.preventDefault();
			onChange(values.slice(0, -1));
		}
	};

	const remove = (index: number): void => {
		onChange(values.filter((_entry, at) => at !== index));
		box.current?.focus();
	};

	// Case-insensitively, matching how `commit` dedupes: a suggestion still offered after its own
	// header was added under a different capitalisation is an offer that does nothing.
	const chosen = new Set(values.map((value) => value.toLowerCase()));
	const offered = suggestions.filter((entry) => !chosen.has(entry.toLowerCase()));

	// The box is not a <label>, though it wraps an input: a click on a badge's remove button would
	// then also focus the box through the label's own activation behaviour, fighting the focus
	// `remove` moves there deliberately.
	//
	// The two ignores below are for the same fact. That div is not a control and does not want a
	// role: it is a border drawn around one. The control is the input inside it, which is in the tab
	// order and takes every key this component handles; the handler only forwards a click on the
	// padding to it, which is what makes the whole box feel like one field to a mouse. There is
	// nothing a keyboard user could do with a handler on the div that they cannot already do on the
	// input.
	return (
		<div className="flex flex-col gap-1.5">
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the inner input is the keyboard target and is reachable on its own. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: as above — a wrapper forwarding a mouse click, not a control. */}
			<div
				onClick={() => box.current?.focus()}
				className={cn(
					"flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border bg-transparent px-2 py-1.5 text-sm",
					"focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
					refused ? "border-destructive" : "border-input",
					disabled ? "cursor-not-allowed opacity-50" : "cursor-text",
				)}
			>
				{values.map((value, index) => (
					<span
						key={value}
						className="flex items-center gap-1 rounded bg-muted py-0.5 pr-0.5 pl-1.5 font-mono text-[11.5px] text-foreground"
					>
						{value}
						<button
							type="button"
							disabled={disabled}
							aria-label={`Remove ${value}`}
							title={`Remove ${value}`}
							className="rounded p-0.5 text-subtle-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none"
							onClick={(event) => {
								// The wrapper focuses the box on click; without this the removal would also
								// be a click on the wrapper.
								event.stopPropagation();
								remove(index);
							}}
						>
							<X className="size-3" />
						</button>
					</span>
				))}

				<input
					ref={box}
					value={draft}
					disabled={disabled}
					aria-label={label}
					placeholder={values.length === 0 ? placeholder : undefined}
					className="min-w-24 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-subtle-foreground disabled:cursor-not-allowed"
					onChange={(event) => {
						setDraft(event.target.value);
						setRefused(false);
					}}
					onKeyDown={onKeyDown}
					// Committed on the way out too. A typed entry the operator never pressed Enter on is
					// one they believe they added, and losing it silently on Save is worse than adding it.
					onBlur={() => {
						if (draft.trim() !== "" && commit(draft)) {
							setDraft("");
							setRefused(false);
						}
					}}
					onPaste={(event) => {
						const text = event.clipboardData.getData("text");
						if (/[,\s\n]/.test(text)) {
							event.preventDefault();
							if (commit(text)) {
								setRefused(false);
							} else {
								setRefused(true);
							}
						}
					}}
				/>
			</div>

			{/* Only what is not already in the box, so every chip here does something. The row goes
			    entirely once they have all been added, rather than leaving a heading over five
			    disabled buttons. */}
			{offered.length === 0 || disabled ? null : (
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-[11px] text-subtle-foreground">Common ones:</span>
					{offered.map((entry) => (
						<button
							key={entry}
							type="button"
							title={`Add ${entry}`}
							className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-subtle-foreground hover:border-input hover:bg-accent hover:text-foreground"
							onClick={() => {
								commit(entry);
								// Back to the box, so adding one and typing another is uninterrupted.
								box.current?.focus();
							}}
						>
							{entry}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
