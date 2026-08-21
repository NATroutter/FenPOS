"use client";

import { useState, useTransition } from "react";
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

/**
 * The administrator's own account, reached from the sidebar footer.
 *
 * Separated from Settings because the two answer different questions. Settings is about the
 * install — limits every device inherits, how long job history is kept — and is the sort of
 * page an operator visits to change something they thought about first. A password change is
 * about the person at the keyboard, is reached for on impulse, and belongs next to the name
 * it concerns and the sign-out button beside it.
 *
 * A dialog rather than a page because there is nothing else to put on that page. Controlled by
 * the caller rather than holding its own `open` state, so it now opens from the account menu
 * rather than from a button of its own.
 */
export function ProfileDialog({
	open,
	onOpenChange,
	minimumLength,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	minimumLength: number;
}) {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();

	const reset = (): void => {
		setCurrent("");
		setNext("");
		setConfirm("");
		setError(null);
	};

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
			reset();
			onOpenChange(false);
			toast.success("Password changed. Other sessions have been signed out.");
		});
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				onOpenChange(nextOpen);
				// Typed credentials do not survive the dialog closing, however it closed.
				if (!nextOpen) {
					reset();
				}
			}}
		>
			<DialogContent className="sm:max-w-[420px]">
				<DialogHeader>
					<DialogTitle>Administrator</DialogTitle>
					<DialogDescription>
						The single credential for this console. Changing it signs out every other session immediately, which is the
						point of changing it.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="flex flex-col gap-4">
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
								At least {minimumLength} characters. Spaces are fine; a passphrase is ideal.
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
					</div>
				</DialogBody>
				<DialogFooter>
					<Button type="button" disabled={pending || current === "" || next === "" || confirm === ""} onClick={submit}>
						{pending ? <Spinner className="size-3.5" /> : null}
						Change password
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
