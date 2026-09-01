"use client";

import { useEffect, useState } from "react";
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
 * Re-typing the current password, as a step in front of something that needs it.
 *
 * A dialog rather than a field on the form it guards. The password is not part of what is being
 * changed — it is the price of being allowed to change it — so leaving a box for it sitting on a
 * panel makes it look like a setting, and makes the panel look like a form that must be filled in
 * before its buttons mean anything. Asked for at the moment the button is pressed, it reads as what
 * it is: a check.
 *
 * It owns the typed password and nothing else. Whether the password was right is the caller's
 * business, so `pending` and `error` come in from outside — the caller is the one running the server
 * action, and the dialog stays open on a refusal so the operator can try again.
 *
 * @param confirmLabel what the button says — the caller's action, not "OK"
 * @param destructive true when confirming makes the account easier to reach
 * @param onConfirm the typed password, on submit
 */
export function PasswordPromptDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	destructive = false,
	pending,
	error,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	confirmLabel: string;
	destructive?: boolean;
	pending: boolean;
	error: string | null;
	onConfirm: (password: string) => void;
}) {
	const [password, setPassword] = useState("");

	// Never carried from one prompt to the next, so a refusal that is still on screen when the dialog
	// is reopened cannot be resubmitted by pressing the button twice.
	useEffect(() => {
		if (open) {
			setPassword("");
		}
	}, [open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[440px]">
				{/* A real form, so Enter submits — this is one field and a button, and reaching for the
				    mouse to finish it would be the slowest part of the whole flow. */}
				<form
					className="flex min-h-0 flex-col"
					onSubmit={(event) => {
						event.preventDefault();
						if (!pending && password !== "") {
							onConfirm(password);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<Field>
							<FieldLabel htmlFor="password-prompt">Current password</FieldLabel>
							<PasswordInput
								id="password-prompt"
								autoComplete="current-password"
								value={password}
								disabled={pending}
								onChange={(event) => setPassword(event.target.value)}
							/>
							<FieldDescription>
								Asked for even though you are signed in — a session left open on an unattended machine is the case this
								defends against.
							</FieldDescription>
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
						<Button
							type="submit"
							variant={destructive ? "destructive" : "default"}
							disabled={pending || password === ""}
						>
							{pending ? <Spinner className="size-3.5" /> : null}
							{confirmLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
