"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { changePassword } from "@/app/(panel)/settings/actions";
import { PasswordInput } from "@/components/password-input";
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
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { minimumLengthPhrase } from "@/lib/auth/password-policy";

/**
 * Changing your own password.
 *
 * Its own dialog rather than a panel of the profile's, because it is a form that commits on its own
 * and everything else on the Security panel is a button that opens something. Left inline, the
 * profile dialog's footer had to be a "Change password" button on that one category and a "Save
 * profile" button on another, so the same band meant a different thing depending on where you had
 * clicked.
 *
 * Opened as a sibling of the profile dialog, never a child: a dialog nested in another's content
 * unmounts the moment that one closes, and the two are never meant to be on screen together.
 *
 * @param minimumLength what the install's policy currently demands, for the description
 * @param onChanged told after the server has accepted the change
 */
export function PasswordChangeDialog({
	open,
	onOpenChange,
	minimumLength,
	onChanged,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	minimumLength: number;
	onChanged: () => void;
}) {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();

	// Nothing typed here survives the dialog closing. A half-finished password change that reappeared
	// the next time this was opened would be a password on screen that nobody meant to still be there.
	useEffect(() => {
		if (!open) {
			return;
		}
		setCurrent("");
		setNext("");
		setConfirm("");
		setError(null);
	}, [open]);

	const submit = (): void => {
		setError(null);
		if (next !== confirm) {
			setError("The new passwords do not match.");
			return;
		}
		startTransition(async () => {
			const result = await changePassword(current, next);
			if (result.error) {
				setError(result.error);
				return;
			}
			onOpenChange(false);
			onChanged();
			toast.success("Password changed. Other sessions have been signed out.");
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[440px]">
				<form
					className="flex min-h-0 flex-col"
					onSubmit={(event) => {
						event.preventDefault();
						if (!pending && current !== "" && next !== "" && confirm !== "") {
							submit();
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>Change password</DialogTitle>
						<DialogDescription>Every other session is signed out immediately, which is the point.</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<Field>
							<FieldLabel htmlFor="profile-current">Current password</FieldLabel>
							<PasswordInput
								id="profile-current"
								autoComplete="current-password"
								value={current}
								disabled={pending}
								onChange={(event) => setCurrent(event.target.value)}
							/>
							<FieldDescription>
								Asked for even though you are signed in — a session left open on an unattended machine is the case this
								defends against.
							</FieldDescription>
						</Field>

						<Field>
							<FieldLabel htmlFor="profile-new">New password</FieldLabel>
							<PasswordInput
								id="profile-new"
								autoComplete="new-password"
								value={next}
								disabled={pending}
								onChange={(event) => setNext(event.target.value)}
							/>
							<FieldDescription>
								At least {minimumLengthPhrase(minimumLength)}. Spaces are fine; a passphrase is ideal.
							</FieldDescription>
						</Field>

						<Field>
							<FieldLabel htmlFor="profile-confirm">Confirm new password</FieldLabel>
							<PasswordInput
								id="profile-confirm"
								autoComplete="new-password"
								value={confirm}
								disabled={pending}
								onChange={(event) => setConfirm(event.target.value)}
							/>
						</Field>

						{error ? (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
					</DialogBody>
					<DialogFooter>
						<Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={pending || current === "" || next === "" || confirm === ""}>
							{pending ? <Spinner className="size-3.5" /> : null}
							Change password
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
