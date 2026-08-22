"use client";

import { X } from "lucide-react";
import { useState } from "react";
import { type AcceptedFormats, acceptAttributeFor } from "@/app/(panel)/assets/prose";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { describeBytes } from "@/lib/format/bytes";

/**
 * Where an image's bytes come from: a file on this machine, or a URL this server fetches.
 *
 * **Tabs rather than two fields that disable each other.** The earlier form put both on screen and
 * let a value in one grey out the other, which said the right thing but said it by taking a control
 * away — an operator who had typed a URL and then wanted a file had to work out that clearing the
 * URL was what would give the file input back. A tab is the same exclusivity stated before the fact:
 * there is one way to answer, and switching which is a click rather than a deduction.
 *
 * Shared by the add and replace dialogs, which ask the identical question. Two copies of this would
 * be two copies of the size check, the accept attribute and the clear button, and the day one
 * changed is the day they stopped agreeing.
 */

/** Which source the operator has chosen. */
export type SourceTab = "file" | "url";

/** The state a dialog holds for one image source, and the handlers that move it. */
export interface ImageSource {
	tab: SourceTab;
	setTab: (next: SourceTab) => void;
	file: File | null;
	url: string;
	setUrl: (next: string) => void;
	/** Bumped to remount the file input, which is the only way to clear what it displays. */
	slot: number;
	/** A refusal raised here, before anything was sent. Cleared by the next edit. */
	error: string | null;
	setError: (next: string | null) => void;
	choose: (chosen: File | null) => void;
	clearFile: () => void;
	reset: () => void;
	/** Whether the chosen tab has an answer in it. */
	ready: boolean;
	/** The URL with surrounding space removed, which is what gets submitted. */
	trimmedUrl: string;
}

/**
 * Holds one image source's state.
 *
 * @param maxBytes the configured upload cap, used to refuse an oversized file before it is sent
 * @returns the state and the handlers a dialog needs
 */
export function useImageSource(maxBytes: number): ImageSource {
	const [tab, setTab] = useState<SourceTab>("file");
	const [file, setFile] = useState<File | null>(null);
	const [url, setUrl] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [slot, setSlot] = useState(0);

	const trimmedUrl = url.trim();

	/** Drops the chosen file, and the filename the input is still displaying with it. */
	const clearFile = (): void => {
		setFile(null);
		setSlot((current) => current + 1);
	};

	/**
	 * Takes the chosen file, refusing one too large to send.
	 *
	 * The server checks this too, twice, and its answer is the one that decides. This copy exists
	 * because past a certain size the server's answer never arrives: Next rejects a server action
	 * whose body is over `serverActions.bodySizeLimit` before the action runs, so a 20 MB holiday
	 * photograph would fail as a thrown request rather than as the sentence the action would have
	 * returned. Refusing it here also spares the operator uploading megabytes to be told no.
	 */
	const choose = (chosen: File | null): void => {
		if (chosen && chosen.size > maxBytes) {
			// `clearFile`, not `setFile(null)`: the input keeps showing whatever the picker put in it
			// until its key changes, so dropping only the form's copy leaves the operator looking at a
			// filename the form no longer has — with Clear disabled, because that is keyed off `file`.
			clearFile();
			setError(`That image is ${describeBytes(chosen.size)}. The limit is ${describeBytes(maxBytes)}.`);
			return;
		}
		setError(null);
		setFile(chosen);
	};

	return {
		tab,
		/** Switching tabs clears the refusal, which belonged to the source being left behind. */
		setTab: (next) => {
			setTab(next);
			setError(null);
		},
		file,
		url,
		setUrl,
		slot,
		error,
		setError,
		choose,
		clearFile,
		reset: () => {
			setTab("file");
			setUrl("");
			setError(null);
			clearFile();
		},
		ready: tab === "file" ? file !== null : trimmedUrl !== "",
		trimmedUrl,
	};
}

/**
 * The File / URL tabs.
 *
 * @param source the state from {@link useImageSource}
 * @param acceptedFormats the configured `assets.acceptedFormats`, for the file picker's filter
 * @param disabled whether a save is in flight
 * @param idPrefix distinguishes this instance's input ids from another dialog's on the same page
 */
export function ImageSourceTabs({
	source,
	acceptedFormats,
	disabled,
	idPrefix,
}: {
	source: ImageSource;
	acceptedFormats: AcceptedFormats;
	disabled: boolean;
	idPrefix: string;
}) {
	return (
		<Tabs value={source.tab} onValueChange={(next) => source.setTab(next as SourceTab)}>
			<TabsList className="w-full">
				<TabsTrigger value="file" disabled={disabled}>
					File
				</TabsTrigger>
				<TabsTrigger value="url" disabled={disabled}>
					URL
				</TabsTrigger>
			</TabsList>

			<TabsContent value="file" className="pt-1">
				<Field>
					<FieldLabel htmlFor={`${idPrefix}-file`}>File</FieldLabel>
					<div className="flex gap-2">
						<Input
							// Remounted to clear it. A file input's value cannot be assigned from React, so
							// without this the browser would go on showing the filename after the file was
							// dropped from state — a control and a form disagreeing about what is selected.
							key={source.slot}
							id={`${idPrefix}-file`}
							type="file"
							accept={acceptAttributeFor(acceptedFormats)}
							disabled={disabled}
							onChange={(event) => source.choose(event.target.files?.[0] ?? null)}
						/>
						<Button
							type="button"
							variant="outline"
							size="icon"
							className="size-8"
							title="Clear the chosen file"
							aria-label="Clear the chosen file"
							disabled={disabled || source.file === null}
							onClick={source.clearFile}
						>
							<X className="size-3.5" />
						</Button>
					</div>
					<FieldDescription>From this machine.</FieldDescription>
				</Field>
			</TabsContent>

			<TabsContent value="url" className="pt-1">
				<Field>
					<FieldLabel htmlFor={`${idPrefix}-url`}>URL</FieldLabel>
					<Input
						id={`${idPrefix}-url`}
						value={source.url}
						disabled={disabled}
						placeholder="https://cafe.example/logo.png"
						className="font-mono"
						onChange={(event) => source.setUrl(event.target.value)}
					/>
					<FieldDescription>
						Fetched once, now, by this server. The image is stored; the address is kept only to record where it came
						from, and is never fetched again.
					</FieldDescription>
				</Field>
			</TabsContent>
		</Tabs>
	);
}
