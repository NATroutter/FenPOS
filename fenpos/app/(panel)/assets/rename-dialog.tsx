"use client";

import { type ReactElement, useState, useTransition } from "react";
import { toast } from "sonner";
import { renameAsset } from "@/app/(panel)/assets/actions";
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

/**
 * Changes what markup calls an image.
 *
 * **The warning is the point of this dialog.** A name is not a label on the picture, it is the
 * reference: every receipt saying `<image>old</image>` is refused from the moment a rename lands,
 * which is the same consequence a delete has and is far less obvious. Nothing on the server refuses
 * a rename for having references — the panel cannot tell the operator which receipts those are, and
 * a refusal they cannot act on from this tab would be worse than a sentence that tells them what
 * they are about to do.
 *
 * The old name is free again afterwards, so an operator who wanted to shuffle two names can, one
 * rename at a time.
 */
export function RenameDialog({
	assetId,
	assetName,
	trigger,
}: {
	assetId: string;
	assetName: string;
	trigger: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState(assetName);
	const [error, setError] = useState<string | null>(null);
	const [saving, startSave] = useTransition();

	const trimmed = name.trim();
	const ready = trimmed !== "" && trimmed !== assetName;

	const submit = (): void => {
		setError(null);
		const finalName = toNameCandidate(name);

		startSave(async () => {
			const result = await renameAsset(assetId, finalName);
			if (result.error) {
				setError(result.error);
				return;
			}
			toast.success(`${assetName} is now ${finalName}.`);
			setOpen(false);
		});
	};

	/** Returns the field to the stored name, which is what the dialog opens showing. */
	const reset = (): void => {
		setName(assetName);
		setError(null);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) {
					reset();
				}
			}}
			onOpenChangeComplete={(nowOpen) => {
				if (!nowOpen) {
					reset();
				}
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-[480px]">
				<DialogHeader>
					<DialogTitle>Rename {assetName}</DialogTitle>
					<DialogDescription>
						Any receipt that says <span className="font-mono">&lt;image&gt;{assetName}&lt;/image&gt;</span> is refused
						until it is changed to the new name, or until an image called <span className="font-mono">{assetName}</span>{" "}
						is stored again. The picture itself is untouched.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="flex flex-col gap-4">
						<Field>
							<FieldLabel htmlFor={`asset-rename-${assetId}`}>Name</FieldLabel>
							<Input
								id={`asset-rename-${assetId}`}
								value={name}
								disabled={saving}
								placeholder="logo"
								onChange={(event) => setName(toNameCandidate(event.target.value, { keepTrailingSeparator: true }))}
							/>
							<FieldDescription>
								A slug, for the same reason printer names are. Markup will refer to it as{" "}
								<span className="font-mono">&lt;image&gt;{trimmed || "…"}&lt;/image&gt;</span>.
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
					<Button type="button" disabled={saving || !ready} onClick={submit}>
						{saving ? <Spinner className="size-3.5" /> : null}
						Rename
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
