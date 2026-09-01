"use client";

import { useEffect, useState } from "react";
import { type LockedPermission, PermissionChecklist } from "@/components/panel/permission-checklist";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

/**
 * A permission checklist on a screen of its own.
 *
 * Fifty checkboxes is not a field, and it stopped being one the moment the form it belonged to had
 * anything else on it: the list ran three times the height of everything above it, so the form was
 * off screen by the time you reached the permission you came for.
 *
 * **It saves nothing.** Applying hands the list back to whoever opened it, which stages it with
 * everything else and writes it on Save. That is why this holds its own draft: Cancel has to mean
 * "leave what was staged alone", not "revert to what the server holds".
 *
 * Shared by the account and role screens, and controlled by both. Rendered as a sibling of the
 * dialog that opens it rather than inside it — the two are never meant to be on screen together, and
 * a dialog nested in another's content unmounts the moment that one closes.
 *
 * @param locked rows shown ticked and disabled, each with the reason beside it
 * @param value the permissions currently staged by the caller
 * @param onApply the permissions the operator settled on
 */
export function PermissionsDialog({
	open,
	onOpenChange,
	title,
	description,
	locked,
	value,
	onApply,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	locked: LockedPermission[];
	value: string[];
	onApply: (permissions: string[]) => void;
}) {
	const [draft, setDraft] = useState<string[]>(value);

	// Opening starts from what is staged, not from what was left here last time. Keyed on `open`
	// alone: `value` is the caller's staged list and changes as this dialog applies to it, so
	// depending on it would reset the draft mid-edit.
	useEffect(() => {
		if (open) {
			setDraft(value);
		}
	}, [open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[88vh] sm:max-w-[820px]">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<PermissionChecklist selected={draft} locked={locked} disabled={false} onChange={setDraft} />
				</DialogBody>
				<DialogFooter>
					<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						type="button"
						onClick={() => {
							onApply(draft);
							onOpenChange(false);
						}}
					>
						Apply
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
