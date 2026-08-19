"use client";

import { UserCog } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { changePassword } from "@/app/(panel)/settings/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
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

/**
 * The administrator's own account, reached from the sidebar footer.
 *
 * Separated from Settings because the two answer different questions. Settings is about the
 * install — limits every device inherits, how long job history is kept — and is the sort of
 * page an operator visits to change something they thought about first. A password change is
 * about the person at the keyboard, is reached for on impulse, and belongs next to the name
 * it concerns and the sign-out button beside it.
 *
 * A dialog rather than a page because there is nothing else to put on that page.
 */
export function ProfileDialog({ minimumLength }: { minimumLength: number }) {
	const [open, setOpen] = useState(false);
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
			setOpen(false);
			toast.success("Password changed. Other sessions have been signed out.");
		});
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				setOpen(nextOpen);
				// Typed credentials do not survive the dialog closing, however it closed.
				if (!nextOpen) {
					reset();
				}
			}}
		>
			<DialogTrigger
				render={
					<Button variant="outline" size="icon" className="size-8" title="Profile" aria-label="Profile">
						<UserCog className="size-3.5" />
					</Button>
				}
			/>

			<DialogContent className="sm:max-w-[420px]">
				<DialogHeader>
					<DialogTitle>Administrator</DialogTitle>
					<DialogDescription>
						The single credential for this console. Changing it signs out every other session immediately, which is the
						point of changing it.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					<Field>
						<FieldLabel htmlFor="profile-current">Current password</FieldLabel>
						<Input
							id="profile-current"
							type="password"
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
						<Input
							id="profile-new"
							type="password"
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
						<Input
							id="profile-confirm"
							type="password"
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
