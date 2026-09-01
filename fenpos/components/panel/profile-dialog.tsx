"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
	removeOwnAvatar,
	setOwnAvatar,
	startTwoFactor,
	stopTwoFactor,
	updateProfile,
} from "@/app/(panel)/settings/actions";
import { AvatarCropDialog } from "@/components/panel/avatar-crop-dialog";
import type { CropperValue } from "@/components/panel/avatar-cropper";
import { DirtyDot } from "@/components/panel/dirty-dot";
import { PasswordChangeDialog } from "@/components/panel/password-change-dialog";
import { PasswordPromptDialog } from "@/components/panel/password-prompt-dialog";
import { type EnrolmentMaterial, TwoFactorSetupDialog } from "@/components/panel/two-factor-setup-dialog";
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
import { MAXIMUM_DISPLAY_NAME_LENGTH, minimumLengthPhrase } from "@/lib/auth/password-policy";
import { cn } from "@/lib/utils";

type Category = "account" | "security";

/** Which of the two things the password prompt is standing in front of, or null when it is closed. */
type TwoFactorIntent = "enable" | "disable";

/**
 * The signed-in user's own account, reached from the sidebar footer.
 *
 * Separated from Settings because the two answer different questions. Settings is about the
 * install — limits every device inherits, how long job history is kept — and is the sort of
 * page an operator visits to change something they thought about first. A profile is about the
 * person at the keyboard, is reached for on impulse, and belongs next to the name it concerns —
 * reached, like sign-out, from the account menu rather than a page of its own.
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
	twoFactorEnabled,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	minimumLength: number;
	/** The signed-in user's current name, and what the Account panel resets to. */
	displayName: string;
	/** The signed-in user's email. Better Auth requires every account to carry one. */
	email: string;
	/** The stored picture's URL, or null when there is none. Resolved on the server. */
	avatarUrl: string | null;
	initial: string;
	/**
	 * Whether the account already has a confirmed authenticator. Read on the server so the dialog
	 * opens showing the right of its two states.
	 */
	twoFactorEnabled: boolean;
}) {
	const router = useRouter();
	const [category, setCategory] = useState<Category>("account");

	const [name, setName] = useState(displayName);
	const [address, setAddress] = useState(email);
	const [accountError, setAccountError] = useState<string | null>(null);
	const [accountPending, startAccountTransition] = useTransition();

	/**
	 * The avatar is part of this form, not a thing that saves behind it.
	 *
	 * Picking a picture opens the crop dialog, and confirming a crop only stages it here — the bytes
	 * do not leave the browser until Save profile, alongside the name and the email. That is why the
	 * state below is a file, a crop and a preview rather than a URL: nothing has been written yet, so
	 * there is nothing on the server to point at.
	 *
	 * The crop dialog is a sibling of this one, never a child, and the two are never open together.
	 * Opening it closes this dialog and closing it opens this one again, so it is one modal at a time
	 * and you land back where you started. Rendering it outside `DialogContent` is what makes that
	 * possible at all: anything nested in the content unmounts the moment this dialog closes.
	 */
	const [cropOpen, setCropOpen] = useState(false);
	const [pickedFile, setPickedFile] = useState<File | null>(null);
	const [pickedUrl, setPickedUrl] = useState<string | null>(null);
	const [stagedCrop, setStagedCrop] = useState<CropperValue | null>(null);
	const [stagedPreview, setStagedPreview] = useState<string | null>(null);
	const [removeStaged, setRemoveStaged] = useState(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	/**
	 * Two-factor is a button on the Account panel and two dialogs behind it, not a panel of its own.
	 *
	 * It was a third category, which gave a single button its own tab and put a Current password box on
	 * a page that was not asking to change anything. The button now sits with the other things about
	 * this account, and the password is asked for when it is pressed — by {@link PasswordPromptDialog},
	 * which is the same check whether the answer turns two-factor on or off.
	 *
	 * The state lives here rather than beside the button for the same reason the crop does: each of
	 * these dialogs takes over the screen, so this one closes while they are up, and anything held in
	 * the panel they replaced would be unmounted with it. The recovery codes are shown once in an
	 * account's lifetime, so they in particular cannot be held anywhere that closing takes down — which
	 * is why both dialogs are siblings of this one, outside `DialogContent`.
	 */
	const [intent, setIntent] = useState<TwoFactorIntent | null>(null);
	const [twoFactorError, setTwoFactorError] = useState<string | null>(null);
	const [twoFactorPending, startTwoFactorTransition] = useTransition();
	const [setupOpen, setSetupOpen] = useState(false);
	const [enrolment, setEnrolment] = useState<EnrolmentMaterial | null>(null);

	/**
	 * Drops every staged edit on the Account panel, leaving the dialog open.
	 *
	 * Distinct from {@link reset}, which also puts the category back and runs when the dialog closes.
	 * Discard is a decision about the form, not about being here.
	 */
	const discardAccount = (): void => {
		setName(displayName);
		setAddress(email);
		setAccountError(null);
		clearStagedAvatar();
	};

	/** Puts the password form up in this dialog's place, the way choosing a picture does. */
	const changePasswordFor = (): void => {
		setPasswordOpen(true);
		onOpenChange(false);
	};

	/** Puts the password prompt up in this dialog's place, the way choosing a picture does. */
	const askForPassword = (asked: TwoFactorIntent): void => {
		setTwoFactorError(null);
		setIntent(asked);
		onOpenChange(false);
	};

	/**
	 * The answer to the prompt, sent to whichever action the button was for.
	 *
	 * A wrong password leaves the prompt open with the refusal on it — closing it and reopening this
	 * dialog would make a typo look like the whole thing was cancelled.
	 */
	const submitPassword = (password: string): void => {
		setTwoFactorError(null);
		startTwoFactorTransition(async () => {
			if (intent === "disable") {
				const result = await stopTwoFactor(password);
				if (result.error) {
					setTwoFactorError(result.error);
					return;
				}
				setIntent(null);
				onOpenChange(true);
				router.refresh();
				toast.success("Two-factor is off.");
				return;
			}

			const result = await startTwoFactor(password);
			if (result.error || !result.enrolment) {
				setTwoFactorError(result.error ?? "Two-factor could not be set up.");
				return;
			}
			// Straight from one dialog to the next, without this one in between: the password was a step
			// on the way to enrolling, not something to come back from.
			setIntent(null);
			setEnrolment(result.enrolment);
			setSetupOpen(true);
		});
	};

	// The picked file's object URL, released on every replacement and on unmount. The preview beside
	// the form is a data URL rather than a second object URL, so it needs no cleanup of its own.
	useEffect(() => {
		return () => {
			if (pickedUrl) {
				URL.revokeObjectURL(pickedUrl);
			}
		};
	}, [pickedUrl]);

	/** What the avatar beside the form is showing right now: a staged crop, the stored picture, or nothing. */
	const shownAvatarUrl = removeStaged ? null : (stagedPreview ?? avatarUrl);

	/**
	 * Which fields differ from what the server holds, the same idea the settings page runs on.
	 *
	 * Compared against the props rather than tracked with a flag per control, so typing a name and
	 * typing it back is not a change — a dot that stays lit after an edit has been undone teaches an
	 * operator to ignore the dots.
	 *
	 * The avatar is dirty when a crop is staged *or* a removal is, and those are different states: one
	 * has bytes waiting to be uploaded, the other has a stored picture waiting to be deleted.
	 */
	const nameDirty = name !== displayName;
	const emailDirty = address !== email;
	const avatarDirty = stagedPreview !== null || removeStaged;
	const dirtyCount = Number(nameDirty) + Number(emailDirty) + Number(avatarDirty);

	const clearStagedAvatar = (): void => {
		setPickedFile(null);
		setPickedUrl(null);
		setStagedCrop(null);
		setStagedPreview(null);
		setRemoveStaged(false);
		// Without this the same file cannot be picked twice in a row: an unchanged value fires no
		// `change` event, so re-choosing the picture you just cancelled would do nothing.
		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}
	};

	/**
	 * Removing means two different things, and telling them apart is what this is for.
	 *
	 * With a picture staged but not yet saved, there is nothing on the server the button refers to —
	 * Remove just discards the pick. Staging a *server-side* removal in that case is what made Save
	 * report "That account has no avatar to remove" on an account that never had one: the removal was
	 * aimed at a stored picture that did not exist, because the only picture in play was the unsaved
	 * one on screen.
	 */
	const removePicture = (): void => {
		setAccountError(null);
		if (stagedPreview) {
			setPickedFile(null);
			setPickedUrl(null);
			setStagedCrop(null);
			setStagedPreview(null);
			if (fileInputRef.current) {
				fileInputRef.current.value = "";
			}
			return;
		}
		setRemoveStaged(true);
	};

	/** Picking a file goes straight to the crop dialog — there is nothing to decide in between. */
	const choose = (chosen: File | null): void => {
		if (!chosen) {
			return;
		}
		setAccountError(null);
		setRemoveStaged(false);
		setPickedFile(chosen);
		setPickedUrl(URL.createObjectURL(chosen));
		setStagedCrop(null);
		setCropOpen(true);
		onOpenChange(false);
	};

	/** Open when the password form is taking the screen, which it does in this dialog's place. */
	const [passwordOpen, setPasswordOpen] = useState(false);

	const reset = (): void => {
		setCategory("account");
		setName(displayName);
		setAddress(email);
		setAccountError(null);
		// A staged picture is an unsaved edit like the two text fields, and goes the same way they do:
		// closing the dialog without pressing Save discards it rather than leaving it primed to be
		// written the next time the dialog is opened and saved for some unrelated reason.
		clearStagedAvatar();
	};

	/**
	 * Commits the whole Account panel: the name, the email, and whatever was staged for the picture.
	 *
	 * The avatar goes first. It is the change most likely to be refused — the server re-decodes the
	 * bytes and re-checks the crop — and a refusal there should leave the name and email alone rather
	 * than half-applying a form the operator pressed one button on. The reverse order would save the
	 * text, fail on the picture, and leave no way to tell from the dialog which of the two happened.
	 */
	const saveAccount = (): void => {
		setAccountError(null);
		startAccountTransition(async () => {
			if (pickedFile && stagedCrop) {
				const data = new FormData();
				data.set("file", pickedFile);
				data.set("x", String(stagedCrop.x));
				data.set("y", String(stagedCrop.y));
				data.set("size", String(stagedCrop.size));

				const avatarResult = await setOwnAvatar(data);
				if (avatarResult.error) {
					setAccountError(avatarResult.error);
					return;
				}
			} else if (removeStaged && avatarUrl) {
				// `avatarUrl` guards it a second time: only a picture that is actually stored can be
				// removed, and asking the server to remove one that never existed is an error the
				// operator cannot act on.
				const removalResult = await removeOwnAvatar();
				if (removalResult.error) {
					setAccountError(removalResult.error);
					return;
				}
			}

			const result = await updateProfile(name, address);
			if (result.error) {
				setAccountError(result.error);
				return;
			}

			clearStagedAvatar();
			toast.success("Profile saved.");
		});
	};

	// A `switch` rather than a ternary: two categories read cleanly this way, and a third would not
	// have to be threaded through an expression.
	let categoryBody: ReactNode;
	switch (category) {
		case "account":
			categoryBody = (
				<div className="flex min-w-0 flex-1 flex-col gap-4">
					<Field>
						{/*
						 * A plain span, not `FieldLabel`: the trigger it names is a picture with nothing
						 * else in the field for a `<label>` to point at, and a `for`-less label reaches
						 * assistive tech as pointing at nothing.
						 */}
						<span className="flex items-center gap-1.5 text-sm leading-none font-medium select-none">
							Avatar
							{avatarDirty ? <DirtyDot /> : null}
						</span>
						{/*
						 * Label, then control, then description — the same three-part rhythm the Display name
						 * and Email fields below use. The description sits under the whole control at the
						 * dialog's full width rather than in a column beside the picture, which is what made
						 * this field read as a different shape from the two it sits with.
						 */}
						<div className="flex items-center gap-4">
							{/* Display only. The buttons are the one way in — a picture that is also secretly a
							    button is a second, unlabelled control for the same thing. */}
							<Avatar src={shownAvatarUrl} initial={initial} className="size-14 flex-none" />
							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={accountPending}
									onClick={() => fileInputRef.current?.click()}
								>
									{shownAvatarUrl ? "Change picture" : "Choose picture"}
								</Button>
								{shownAvatarUrl ? (
									<Button type="button" variant="outline" size="sm" disabled={accountPending} onClick={removePicture}>
										Remove
									</Button>
								) : null}
							</div>
						</div>
						<FieldDescription>PNG or JPEG, cropped to a square. Saved when you save the profile.</FieldDescription>
						<input
							ref={fileInputRef}
							type="file"
							accept="image/png,image/jpeg"
							className="hidden"
							disabled={accountPending}
							onChange={(event) => choose(event.target.files?.[0] ?? null)}
						/>
					</Field>

					<Field>
						<FieldLabel htmlFor="profile-name" className="gap-1.5">
							Display name
							{nameDirty ? <DirtyDot /> : null}
						</FieldLabel>
						<Input
							id="profile-name"
							maxLength={MAXIMUM_DISPLAY_NAME_LENGTH}
							value={name}
							disabled={accountPending}
							onChange={(event) => setName(event.target.value)}
						/>
					</Field>

					<Field>
						<FieldLabel htmlFor="profile-email" className="gap-1.5">
							Email
							{emailDirty ? <DirtyDot /> : null}
						</FieldLabel>
						<Input
							id="profile-email"
							type="email"
							autoComplete="email"
							value={address}
							disabled={accountPending}
							onChange={(event) => setAddress(event.target.value)}
						/>
						<FieldDescription>Used to sign in, and to identify the account.</FieldDescription>
					</Field>

					{accountError ? (
						<Alert variant="destructive">
							<AlertDescription>{accountError}</AlertDescription>
						</Alert>
					) : null}
				</div>
			);
			break;

		case "security":
			// Two things that can be changed about getting in, each one a button that opens the screen
			// that changes it. Nothing here is staged and nothing here is saved by a footer: the password
			// form used to sit inline, which made this dialog's footer mean "Save profile" on one
			// category and "Change password" on another.
			//
			// Both use a plain span rather than `FieldLabel`: what they name is a button, and a
			// `for`-less label reaches assistive tech as pointing at nothing.
			categoryBody = (
				<div className="flex min-w-0 flex-1 flex-col gap-4">
					<Field>
						<span className="text-sm leading-none font-medium select-none">Password</span>
						<div>
							<Button type="button" variant="outline" size="sm" onClick={changePasswordFor}>
								Change password
							</Button>
						</div>
						<FieldDescription>
							At least {minimumLengthPhrase(minimumLength)}. Changing it signs out every other session immediately,
							which is the point of changing it.
						</FieldDescription>
					</Field>

					<Field>
						<span className="text-sm leading-none font-medium select-none">Two-factor authentication</span>
						<div>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => askForPassword(twoFactorEnabled ? "disable" : "enable")}
							>
								{twoFactorEnabled ? "Turn two-factor off" : "Set up two-factor"}
							</Button>
						</div>
						<FieldDescription>
							{twoFactorEnabled
								? "On. This account asks for a code from your authenticator every time you sign in. Turning it off takes effect immediately."
								: "An authenticator app produces a six-digit code that changes every thirty seconds, so knowing your password is not enough to sign in as you."}
						</FieldDescription>
					</Field>
				</div>
			);
			break;
	}

	// The band is there when there is something to press and gone when there is not — the same bargain
	// the settings page's save bar makes, and the reason nothing here is a Close button duplicating the
	// X. The dialog does not resize when it comes and goes: `DialogContent` is pinned to a fixed
	// height, so the body takes the room back.
	let footer: ReactNode = null;
	switch (category) {
		case "account":
			if (dirtyCount > 0) {
				footer = (
					<>
						<span className="mr-auto text-[12.5px] text-muted-foreground">
							{dirtyCount === 1 ? "1 unsaved change" : `${dirtyCount} unsaved changes`}
						</span>
						<Button type="button" variant="ghost" disabled={accountPending} onClick={discardAccount}>
							Discard
						</Button>
						<Button
							type="button"
							disabled={accountPending || name.trim() === "" || address.trim() === ""}
							onClick={saveAccount}
						>
							{accountPending ? <Spinner className="size-3.5" /> : null}
							Save profile
						</Button>
					</>
				);
			}
			break;

		case "security":
			// No band at all. Nothing on this panel commits, and a Close button under it was a second
			// control for what the X in the corner already does. The dialog does not change size when it
			// goes: `DialogContent` is pinned to a fixed height, so the body simply takes the room back.
			break;
	}

	return (
		<>
			<AvatarCropDialog
				open={cropOpen}
				onOpenChange={(nextOpen) => {
					setCropOpen(nextOpen);
					// Closing the crop dialog — confirmed or cancelled — puts this one back, so choosing a
					// picture is a detour through a second modal rather than a way out of the first.
					if (!nextOpen) {
						onOpenChange(true);
					}
				}}
				src={pickedUrl}
				onConfirm={(crop, preview) => {
					setStagedCrop(crop);
					setStagedPreview(preview);
				}}
			/>
			<PasswordChangeDialog
				open={passwordOpen}
				onOpenChange={(nextOpen) => {
					setPasswordOpen(nextOpen);
					// Changed or cancelled, this dialog comes back — the same detour every other button on
					// the Security panel makes.
					if (!nextOpen) {
						onOpenChange(true);
					}
				}}
				minimumLength={minimumLength}
				onChanged={() => {
					// The change signs out every other session, not this one, so there is nothing to leave
					// for — but the panel behind this reads its state from the server.
					router.refresh();
				}}
			/>
			<PasswordPromptDialog
				open={intent !== null}
				onOpenChange={(nextOpen) => {
					// Only ever a cancel: a password that was accepted closes this by clearing `intent`,
					// which the dialog cannot see as a dismissal and so never reports here.
					if (!nextOpen) {
						setIntent(null);
						setTwoFactorError(null);
						onOpenChange(true);
					}
				}}
				title={intent === "disable" ? "Turn two-factor off" : "Set up two-factor"}
				description={
					intent === "disable"
						? "This account will stop asking for a code from your authenticator."
						: "Confirm it is you, and the next screen has your recovery codes."
				}
				confirmLabel={intent === "disable" ? "Turn two-factor off" : "Continue"}
				destructive={intent === "disable"}
				pending={twoFactorPending}
				error={twoFactorError}
				onConfirm={submitPassword}
			/>
			<TwoFactorSetupDialog
				open={setupOpen}
				onOpenChange={(nextOpen) => {
					setSetupOpen(nextOpen);
					if (!nextOpen) {
						// However the enrolment ended — confirmed, or abandoned before it was — this dialog
						// comes back, the same detour the crop dialog makes. The material goes with the
						// screen that showed it: an abandoned enrolment is never confirmed, and a confirmed
						// one has just had its recovery codes dismissed on purpose.
						setEnrolment(null);
						onOpenChange(true);
					}
				}}
				enrolment={enrolment}
				onDone={() => {
					// `twoFactorEnabled` is read on the server, so without this the dialog would reopen still
					// offering to set up the authenticator that was just set up.
					router.refresh();
				}}
			/>
			<Dialog
				open={open}
				onOpenChange={onOpenChange}
				onOpenChangeComplete={(nowOpen) => {
					// **After the close animation, not during it.** Resetting inside `onOpenChange` put the
					// category back to Account while the dialog was still fading out, so closing from the
					// Security panel flashed the Account panel on the way off screen.
					//
					// This fires on every close, including the ones a detour causes — so unlike the old
					// handler it has to check for them itself. Coming back from the crop, the password form
					// or the enrolment to a form that had silently reset itself would lose whatever was
					// half-typed in it.
					if (nowOpen || cropOpen || passwordOpen || setupOpen || intent !== null) {
						return;
					}
					reset();
				}}
			>
				{/*
				 * A fixed 80% of the viewport, so the dialog is the same size on every category. The height
				 * belongs here rather than on the body: this is the element the header, body and footer are
				 * laid out inside, so pinning it makes the body take whatever is left over and the whole
				 * dialog stop resizing when the category changes.
				 */}
				<DialogContent className="h-[50vh] sm:max-w-[820px]">
					<DialogHeader>
						<DialogTitle>Your account</DialogTitle>
						{/* The password sentence used to live here as well, back when the form did. It is on the
						    Security panel now, beside the button it is about. */}
						<DialogDescription>Who you are here, and what it takes to sign in as you.</DialogDescription>
					</DialogHeader>
					{/*
					{/*
					 * No height of its own: `DialogContent` above is pinned to 80vh, so this takes whatever
					 * the header and footer leave. The scroll sits on the category column below rather than
					 * here, because with `flex-row` a scrolling body would take the nav with it.
					 */}
					<DialogBody className="flex-row items-start gap-6 overflow-hidden">
						<nav className="flex w-[170px] flex-none flex-col gap-1">
							{/* The marker on the rail, as on the settings page: an edit you have navigated away
							    from is still staged and still saved, so a category that looks untouched has to say
							    it is not. */}
							<button
								type="button"
								onClick={() => setCategory("account")}
								className={cn(
									"flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium transition-colors",
									category === "account"
										? "bg-sidebar-accent text-sidebar-accent-foreground"
										: "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
								)}
							>
								<span className="min-w-0 flex-1 truncate">Account</span>
								{dirtyCount > 0 ? <DirtyDot /> : null}
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

						{/* Takes the body's fixed height and scrolls within it, so a taller category scrolls
						    instead of resizing the dialog — and the nav beside it stays put. */}
						<div className="h-full min-w-0 flex-1 overflow-y-auto pr-1">{categoryBody}</div>
					</DialogBody>
					{footer ? <DialogFooter>{footer}</DialogFooter> : null}
				</DialogContent>
			</Dialog>
		</>
	);
}
