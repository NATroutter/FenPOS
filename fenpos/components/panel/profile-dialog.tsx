"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { changePassword, updateProfile } from "@/app/(panel)/settings/actions";
import { PasswordInput } from "@/components/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
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
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { MAXIMUM_DISPLAY_NAME_LENGTH } from "@/lib/auth/profile";
import { cn } from "@/lib/utils";

type Category = "account" | "security";

/**
 * The administrator's own account, reached from the sidebar footer.
 *
 * Separated from Settings because the two answer different questions. Settings is about the
 * install — limits every device inherits, how long job history is kept — and is the sort of
 * page an operator visits to change something they thought about first. A profile is about the
 * person at the keyboard, is reached for on impulse, and belongs next to the name it concerns and
 * the sign-out button beside it.
 *
 * Two categories rather than one form, because a name and an email answer a different question
 * than a password does, and conflating them under one Save would make one a side effect of the
 * other. The category itself is local state — not routed, not stored — because a dialog's open
 * category is not somewhere you send a link to.
 *
 * A dialog rather than a page because there is nothing else to put on that page. Controlled by
 * the caller rather than holding its own `open` state, so it now opens from the account menu
 * rather than from a button of its own.
 */
export function ProfileDialog({
	open,
	onOpenChange,
	minimumLength,
	displayName,
	email,
	avatarUrl,
	initial,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	minimumLength: number;
	/** The administrator's current name, and what the Account panel resets to. */
	displayName: string;
	/** Null when none is set, which is also what selects the drawn initial over a Gravatar. */
	email: string | null;
	/** Resolved on the server, so no address and no hashing reach the browser. */
	avatarUrl: string | null;
	initial: string;
}) {
	const [category, setCategory] = useState<Category>("account");

	const [name, setName] = useState(displayName);
	const [address, setAddress] = useState(email ?? "");
	const [accountError, setAccountError] = useState<string | null>(null);
	const [accountPending, startAccountTransition] = useTransition();

	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();

	const reset = (): void => {
		setCategory("account");
		setName(displayName);
		setAddress(email ?? "");
		setAccountError(null);
		setCurrent("");
		setNext("");
		setConfirm("");
		setError(null);
	};

	const saveAccount = (): void => {
		setAccountError(null);
		startAccountTransition(async () => {
			const result = await updateProfile(name, address);
			if (result.error) {
				setAccountError(result.error);
				return;
			}
			toast.success("Profile saved.");
		});
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
				// Typed edits do not survive the dialog closing, however it closed.
				if (!nextOpen) {
					reset();
				}
			}}
		>
			<DialogContent className="sm:max-w-[720px]">
				<DialogHeader>
					<DialogTitle>Administrator</DialogTitle>
					<DialogDescription>
						The account for this console: your name, your email, and the password that gets you in. Changing the
						password signs out every other session immediately, which is the point of changing it.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="flex-row items-start gap-6">
					<nav className="flex w-[170px] flex-none flex-col gap-1">
						<button
							type="button"
							onClick={() => setCategory("account")}
							className={cn(
								"rounded-md px-2.5 py-1.5 text-left text-sm font-medium transition-colors",
								category === "account"
									? "bg-sidebar-accent text-sidebar-accent-foreground"
									: "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
							)}
						>
							Account
						</button>
						<button
							type="button"
							onClick={() => setCategory("security")}
							className={cn(
								"rounded-md px-2.5 py-1.5 text-left text-sm font-medium transition-colors",
								category === "security"
									? "bg-sidebar-accent text-sidebar-accent-foreground"
									: "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
							)}
						>
							Security
						</button>
					</nav>

					{category === "account" ? (
						<div className="flex min-w-0 flex-1 flex-col gap-4">
							<Field>
								<FieldLabel htmlFor="profile-name">Display name</FieldLabel>
								<Input
									id="profile-name"
									maxLength={MAXIMUM_DISPLAY_NAME_LENGTH}
									value={name}
									disabled={accountPending}
									onChange={(event) => setName(event.target.value)}
								/>
							</Field>

							<Field>
								<FieldLabel htmlFor="profile-email">Email</FieldLabel>
								<Input
									id="profile-email"
									type="email"
									autoComplete="email"
									value={address}
									disabled={accountPending}
									onChange={(event) => setAddress(event.target.value)}
								/>
								<FieldDescription>
									Used to fetch a picture from Gravatar — the address is hashed on the server before it is sent, never
									in the browser. Leave it blank to use a drawn initial instead.
								</FieldDescription>
							</Field>

							<Field>
								<FieldLabel>Avatar</FieldLabel>
								<div className="flex items-center gap-3">
									<Avatar src={avatarUrl} initial={initial} className="size-12" />
									<FieldDescription className="mt-0">
										The saved avatar. It updates once the profile below is saved.
									</FieldDescription>
								</div>
							</Field>

							{accountError ? (
								<Alert variant="destructive">
									<AlertDescription>{accountError}</AlertDescription>
								</Alert>
							) : null}
						</div>
					) : (
						<div className="flex min-w-0 flex-1 flex-col gap-4">
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
									Asked for even though you are signed in — a session left open on an unattended machine is the case
									this defends against.
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
					)}
				</DialogBody>
				<DialogFooter>
					{category === "account" ? (
						<Button type="button" disabled={accountPending || name.trim() === ""} onClick={saveAccount}>
							{accountPending ? <Spinner className="size-3.5" /> : null}
							Save profile
						</Button>
					) : (
						<Button
							type="button"
							disabled={pending || current === "" || next === "" || confirm === ""}
							onClick={submit}
						>
							{pending ? <Spinner className="size-3.5" /> : null}
							Change password
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
