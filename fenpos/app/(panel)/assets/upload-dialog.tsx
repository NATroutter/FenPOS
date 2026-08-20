"use client";

import { X } from "lucide-react";
import { type ReactElement, useState, useTransition } from "react";
import { toast } from "sonner";
import { importAsset, uploadAsset } from "@/app/(panel)/assets/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toNameCandidate } from "@/lib/domain/naming";

/** What the file picker offers, matching the two formats the decoder accepts. */
const ACCEPTED = "image/png,image/jpeg";

/**
 * Adds an image, from a file or from a URL.
 *
 * **One dialog rather than two.** The choice between uploading a file and fetching a URL is a
 * detail of where the bytes come from; everything else — the name markup will use, the limits, the
 * refusals — is identical, and splitting it in two would put the same form on screen twice and
 * invite them to drift. The two inputs disable each other, so the exclusivity is visible rather
 * than something the operator discovers by being told off after submitting.
 *
 * A URL is fetched **once, now**, and the bytes are stored. `sourceUrl` is kept as provenance and
 * never fetched again, which is worth saying in the dialog: an operator who expects the logo to
 * follow changes at the far end would otherwise find out much later.
 */
export function UploadDialog({ maxBytes, trigger }: { maxBytes: number; trigger: ReactElement }) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [url, setUrl] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, startSave] = useTransition();
	/** Bumped to remount the file input, which is the only way to clear what it displays. */
	const [slot, setSlot] = useState(0);

	const trimmedUrl = url.trim();
	const ready = name.trim() !== "" && (file !== null || trimmedUrl !== "");

	const add = (): void => {
		setError(null);
		const finalName = toNameCandidate(name);

		startSave(async () => {
			let result: { error: string | null };
			if (file) {
				const form = new FormData();
				form.set("name", finalName);
				form.set("file", file);
				result = await uploadAsset(form);
			} else {
				result = await importAsset(finalName, trimmedUrl);
			}

			if (result.error) {
				setError(result.error);
				return;
			}
			toast.success(`${finalName} added.`);
			setOpen(false);
		});
	};

	/**
	 * Takes the chosen file, refusing one too large to send.
	 *
	 * The server checks this too, twice, and its answer is the one that decides. This copy exists
	 * because past a certain size the server's answer never arrives: Next rejects a server action
	 * whose body is over `serverActions.bodySizeLimit` before the action runs, so a 10 MB holiday
	 * photograph would fail as a thrown request rather than as the sentence the action would have
	 * returned. Refusing it here also spares the operator uploading megabytes to be told no.
	 */
	const choose = (chosen: File | null): void => {
		if (chosen && chosen.size > maxBytes) {
			setFile(null);
			setError(`That image is ${(chosen.size / 1024 / 1024).toFixed(1)} MB. The limit is ${megabytes(maxBytes)} MB.`);
			return;
		}
		setError(null);
		setFile(chosen);
	};

	/** Drops the chosen file, so the URL field can be used instead. */
	const clearFile = (): void => {
		setFile(null);
		setSlot((current) => current + 1);
	};

	/** Returns the dialog to its opening state. Safe to call more than once. */
	const reset = (): void => {
		setName("");
		setUrl("");
		setError(null);
		clearFile();
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				// Also on the way in, because reopening inside the closing animation's 100ms never
				// reaches the handler below, and the dialog would come back holding the last attempt.
				if (next) {
					reset();
				}
			}}
			// After the animation rather than at the click. Clearing during the close plays the
			// fade-out on a form that has already emptied itself, which is what made the API-key
			// dialog flash the wrong pane on its way out.
			onOpenChangeComplete={(nowOpen) => {
				if (!nowOpen) {
					reset();
				}
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-[560px]">
				<DialogHeader>
					<DialogTitle>Add an image</DialogTitle>
					<DialogDescription>
						PNG or JPEG, up to {megabytes(maxBytes)} MB. It is stored as uploaded and dithered for each printer's own
						paper width, so the same image suits 58mm and 80mm alike.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="flex flex-col gap-4">
						<Field>
							<FieldLabel htmlFor="asset-name">Name</FieldLabel>
							<Input
								id="asset-name"
								value={name}
								disabled={saving}
								placeholder="logo"
								onChange={(event) => setName(toNameCandidate(event.target.value, { keepTrailingSeparator: true }))}
							/>
							<FieldDescription>
								What markup refers to it by: <span className="font-mono">&lt;image&gt;logo&lt;/image&gt;</span>. A slug,
								for the same reason printer names are.
							</FieldDescription>
						</Field>

						<Field>
							<FieldLabel htmlFor="asset-file">File</FieldLabel>
							<div className="flex gap-2">
								<Input
									// Remounted to clear it. A file input's value cannot be assigned from React, so
									// without this the browser would go on showing the filename after the file was
									// dropped from state — a control and a form disagreeing about what is selected.
									key={slot}
									id="asset-file"
									type="file"
									accept={ACCEPTED}
									disabled={saving || trimmedUrl !== ""}
									onChange={(event) => choose(event.target.files?.[0] ?? null)}
								/>
								<Button
									type="button"
									variant="outline"
									size="icon"
									className="size-8"
									title="Clear the chosen file"
									aria-label="Clear the chosen file"
									disabled={saving || file === null}
									onClick={clearFile}
								>
									<X className="size-3.5" />
								</Button>
							</div>
							<FieldDescription>
								From this machine. Choosing one disables the URL below; clear it to use a URL instead.
							</FieldDescription>
						</Field>

						<div className="flex items-center gap-3">
							<div className="h-px flex-1 bg-border" />
							<span className="text-[11.5px] text-subtle-foreground">or</span>
							<div className="h-px flex-1 bg-border" />
						</div>

						<Field>
							<FieldLabel htmlFor="asset-url">URL</FieldLabel>
							<Input
								id="asset-url"
								value={url}
								disabled={saving || file !== null}
								placeholder="https://cafe.example/logo.png"
								className="font-mono"
								onChange={(event) => setUrl(event.target.value)}
							/>
							<FieldDescription>
								Fetched once, now, by this server. The image is stored; the address is kept only to record where it came
								from, and is never fetched again.
							</FieldDescription>
						</Field>

						{error ? (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
					</div>
				</DialogBody>
				<DialogFooter>
					<Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button type="button" disabled={saving || !ready} onClick={add}>
						{saving ? <Spinner className="size-3.5" /> : null}
						Add image
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * States a byte cap the way the copy says it.
 *
 * The cap arrives from the server as bytes, and every sentence in this dialog says megabytes. One
 * conversion so the description and the refusal cannot end up quoting different numbers.
 *
 * @param bytes the cap
 * @returns whole megabytes
 */
function megabytes(bytes: number): number {
	return Math.floor(bytes / 1024 / 1024);
}
