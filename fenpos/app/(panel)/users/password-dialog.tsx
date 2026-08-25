"use client";

import { type ReactElement, useState, useTransition } from "react";
import { toast } from "sonner";
import { setUserPassword } from "@/app/(panel)/users/actions";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

/**
 * Sets another account's password.
 *
 * The current password is not asked for, unlike the profile dialog's own password change: an
 * administrator resetting somebody's password does not have it, which is the entire reason this
 * exists. Every session that account held ends when this succeeds.
 */
export function PasswordDialog({
	userId,
	accountName,
	trigger,
}: {
	userId: string;
	accountName: string;
	trigger: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, startSave] = useTransition();

	const save = (): void => {
		setError(null);
		startSave(async () => {
			const result = await setUserPassword(userId, password);
			if (result.error) {
				setError(result.error);
				return;
			}
			toast.success(`${accountName}'s password set. Their sessions have ended.`);
			setOpen(false);
		});
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				setPassword("");
				setError(null);
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-[440px]">
				<DialogHeader>
					<DialogTitle>Set {accountName}&apos;s password</DialogTitle>
					<DialogDescription>
						Their sessions end immediately. Nothing is emailed — give them the new password yourself, and require a
						reset if you would rather it did not stay this one.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<Field>
						<FieldLabel htmlFor="set-password">New password</FieldLabel>
						<Input
							id="set-password"
							type="password"
							value={password}
							disabled={saving}
							onChange={(event) => setPassword(event.target.value)}
						/>
					</Field>
					{error ? (
						<Alert variant="destructive" className="mt-3">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
				</DialogBody>
				<DialogFooter>
					<Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button type="button" disabled={saving || password === ""} onClick={save}>
						{saving ? <Spinner className="size-3.5" /> : null}
						Set password
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
