"use client";

import { Camera, ImageOff, KeyRound, LogOut, ShieldOff, SlidersHorizontal, TimerReset } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
	banUser,
	deleteUser,
	disableTwoFactor,
	forcePasswordReset,
	listSessions,
	removeUserAvatar,
	revokeUserSession,
	revokeUserSessions,
	setSuperuser,
	setUserAvatar,
	setUserPassword,
	setUserPermissions,
	setUserRoles,
	type UserSession,
	unbanUser,
	updateUser,
} from "@/app/(panel)/users/actions";
import type { GrantableRole, UserPermits, UserRowData } from "@/app/(panel)/users/user-data";
import { AvatarCropDialog } from "@/components/panel/avatar-crop-dialog";
import type { CropperValue } from "@/components/panel/avatar-cropper";
import { DirtyDot } from "@/components/panel/dirty-dot";
import type { LockedPermission } from "@/components/panel/permission-checklist";
import { PermissionsDialog } from "@/components/panel/permissions-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatDateTime } from "@/lib/format/datetime";
import { cn } from "@/lib/utils";

/** Whether two lists hold the same ids, order aside. */
function sameSet(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((entry) => right.includes(entry));
}

/**
 * Everything about one account, on one screen, committed by one button.
 *
 * **This replaces a row of eight unlabelled icon buttons and the six dialogs behind them.** Each was
 * a permission of its own, so each got its own button, and the result was a wall of glyphs whose only
 * documentation was a `title` attribute. Permissions still gate every control, but they gate
 * *sections of one screen* now, which is a thing you can read.
 *
 * **Nothing here fires when it is clicked.** Requiring a password reset, clearing an enrolment,
 * signing every session out, promoting to superuser — each of those used to be a button behind an
 * "are you sure", which is a confirmation an operator learns to click through. They are staged
 * instead: clicking one arms it, the row says so, and Save changes is the single moment anything
 * happens. That makes Cancel mean what it says and turns four confirmations into one.
 *
 * **Everything on this screen goes through Save, the picture included.** A crop is held as a file
 * and a rectangle until then, exactly as the profile dialog holds its own — a control that wrote at
 * once was a control whose Cancel did nothing and whose Save had nothing to do, and a form where
 * some fields commit differently from the rest is a form nobody can predict.
 *
 * The two exceptions are the two the staging model cannot honestly represent. **Ban** needs a reason
 * and a date, so it is a form rather than a switch. **Delete** ends the thing being edited, so there
 * is nothing left to save afterwards; it keeps its confirmation.
 */
export function ManageUserDialog({
	account,
	roles,
	editorHolds,
	isSelf,
	permits,
	trigger,
}: {
	account: UserRowData;
	roles: GrantableRole[];
	editorHolds: string[];
	isSelf: boolean;
	permits: UserPermits;
	trigger: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	const [permissionsOpen, setPermissionsOpen] = useState(false);

	const [name, setName] = useState(account.name);
	const [email, setEmail] = useState(account.email);
	const [roleIds, setRoleIds] = useState<string[]>(account.roles.map((role) => role.id));
	const [permissions, setPermissions] = useState<string[]>(account.permissions);

	/**
	 * The picture, staged like everything else on this screen.
	 *
	 * It used to write the moment a crop was confirmed, which made this the one control whose Cancel
	 * did nothing and whose Save had nothing to do — an operator had no way to tell which half of the
	 * form they were in. The bytes stay in the browser until Save changes, so the state below is a
	 * file, a crop and a preview rather than a URL: nothing has been written, so there is nothing on
	 * the server to point at.
	 */
	const [pickedFile, setPickedFile] = useState<File | null>(null);
	const [pickedUrl, setPickedUrl] = useState<string | null>(null);
	const [stagedCrop, setStagedCrop] = useState<CropperValue | null>(null);
	const [stagedPreview, setStagedPreview] = useState<string | null>(null);
	const [removeAvatar, setRemoveAvatar] = useState(false);
	const [cropOpen, setCropOpen] = useState(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	// The staged security actions. Each is "what this account should be after Save", not "do this
	// now" — which is why the superuser one is a value rather than a verb.
	const [newPassword, setNewPassword] = useState("");
	const [forceReset, setForceReset] = useState(false);
	const [clearTwoFactor, setClearTwoFactor] = useState(false);
	const [signOutAll, setSignOutAll] = useState(false);
	const [superuser, setSuperuserStaged] = useState(account.isSuperuser);
	const [liftBan, setLiftBan] = useState(false);
	const [revokedSessionIds, setRevokedSessionIds] = useState<string[]>([]);

	const [error, setError] = useState<string | null>(null);
	const [sessions, setSessions] = useState<UserSession[] | null>(null);
	const [saving, startSave] = useTransition();

	const clearStagedAvatar = (): void => {
		setPickedFile(null);
		setPickedUrl(null);
		setStagedCrop(null);
		setStagedPreview(null);
		setRemoveAvatar(false);
		// Without this the same file cannot be picked twice in a row: an unchanged value fires no
		// `change` event, so re-choosing the picture you just cancelled would do nothing.
		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}
	};

	const reset = (): void => {
		setName(account.name);
		setEmail(account.email);
		setRoleIds(account.roles.map((role) => role.id));
		setPermissions(account.permissions);
		clearStagedAvatar();
		setNewPassword("");
		setForceReset(false);
		setClearTwoFactor(false);
		setSignOutAll(false);
		setSuperuserStaged(account.isSuperuser);
		setLiftBan(false);
		setRevokedSessionIds([]);
		setError(null);
	};

	/**
	 * Set while the permissions dialog is taking this one's place, and read once on the way back.
	 *
	 * A ref rather than the `permissionsOpen` flag, because by the time the effect below runs that
	 * flag is already false: closing the permissions dialog sets it false and reopens this one in the
	 * same batch, so the effect sees `open` flip true with nothing left to say why. Without this, a
	 * detour to pick permissions silently discarded every other staged change on the form.
	 */
	const returningFromPermissions = useRef(false);

	/** Set while the crop dialog is taking this one's place — same reason as the flag above. */
	const returningFromCrop = useRef(false);

	// The picked file's object URL, released on every replacement and on unmount. The preview beside
	// the form is a data URL rather than a second object URL, so it needs no cleanup of its own.
	useEffect(() => {
		return () => {
			if (pickedUrl) {
				URL.revokeObjectURL(pickedUrl);
			}
		};
	}, [pickedUrl]);

	/** Picking a file goes straight to the crop dialog — there is nothing to decide in between. */
	const choosePicture = (chosen: File | null): void => {
		if (!chosen) {
			return;
		}
		setRemoveAvatar(false);
		setPickedFile(chosen);
		setPickedUrl(URL.createObjectURL(chosen));
		setStagedCrop(null);
		returningFromCrop.current = true;
		setCropOpen(true);
		setOpen(false);
	};

	// Reopening shows what the server holds, not what was staged and abandoned last time.
	useEffect(() => {
		if (!open) {
			return;
		}
		if (returningFromPermissions.current || returningFromCrop.current) {
			returningFromPermissions.current = false;
			returningFromCrop.current = false;
			return;
		}
		// Deliberately keyed on the account and the open flag alone: `reset` is recreated every render,
		// so depending on it would re-run this on every keystroke and make the form impossible to
		// type in.
		reset();
	}, [open, account]);

	// Fetched on open rather than passed down with the row: a session list goes stale the moment
	// somebody signs in on their phone, and a stale list with a Revoke button beside each line is
	// worse than a brief spinner.
	useEffect(() => {
		if (!open || !permits.revokeSessions) {
			return;
		}
		let current = true;
		void listSessions(account.id).then((found) => {
			if (current) {
				setSessions(found);
			}
		});
		return () => {
			current = false;
		};
	}, [open, account.id, permits.revokeSessions]);

	const nameDirty = name !== account.name;
	const emailDirty = email !== account.email;
	const rolesDirty = !sameSet(
		roleIds,
		account.roles.map((role) => role.id),
	);
	const permissionsDirty = !sameSet(permissions, account.permissions);
	const superuserDirty = superuser !== account.isSuperuser;
	const avatarDirty = stagedPreview !== null || removeAvatar;

	/** What the header shows right now: a staged crop, the stored picture, or nothing. */
	const shownAvatarUrl = removeAvatar ? null : (stagedPreview ?? account.avatarUrl);

	const dirtyCount =
		Number(nameDirty) +
		Number(emailDirty) +
		Number(rolesDirty) +
		Number(permissionsDirty) +
		Number(avatarDirty) +
		Number(newPassword !== "") +
		Number(forceReset) +
		Number(clearTwoFactor) +
		Number(signOutAll) +
		Number(superuserDirty) +
		Number(liftBan) +
		// Any number of individual revocations counts as one change: they are one decision made in one
		// list, and a footer reading "7 unsaved changes" for one visit to that list would be noise.
		Number(revokedSessionIds.length > 0);

	// A role carrying something the editor does not hold cannot be assigned by them. `grant-service.ts`
	// refuses the same thing again; this is what stops the operator finding out only after Save.
	const assignable = roles.filter((role) => role.permissions.every((permission) => editorHolds.includes(permission)));

	/** The newest session's last activity, or null while the list is still on its way. */
	const lastSeen =
		sessions === null || sessions.length === 0
			? null
			: sessions.reduce(
					(newest, session) => (session.updatedAt > newest ? session.updatedAt : newest),
					sessions[0].updatedAt,
				);

	/** How much this account can do, in three words, from what the server holds rather than the form. */
	const accessSummary = account.isSuperuser
		? "Superuser — bypasses every check"
		: account.roles.length === 0 && account.permissions.length === 0
			? "None — this account cannot do anything"
			: "Granted";

	// Two reasons a checkbox is locked, and they say different things. A role's own permission is not
	// this account's grant to remove; a permission the editor does not hold is not theirs to touch at
	// all. Both are shown rather than hidden — an account's authority is not answerable from a form
	// that omits half of it.
	const locked: LockedPermission[] = [];
	for (const role of roles.filter((candidate) => roleIds.includes(candidate.id))) {
		for (const permission of role.permissions) {
			if (!locked.some((entry) => entry.id === permission)) {
				locked.push({ id: permission, reason: `via ${role.name}` });
			}
		}
	}
	for (const permission of account.permissions) {
		if (!editorHolds.includes(permission) && !locked.some((entry) => entry.id === permission)) {
			locked.push({ id: permission, reason: "you do not hold this" });
		}
	}

	const canPromote = permits.setSuperuser && !isSelf;
	const canLiftBan = permits.unban && account.banned;
	const canBan = permits.ban && !account.banned && !isSelf;
	const canDelete = permits.remove && !isSelf;
	const showDanger = canPromote || canLiftBan || canBan || canDelete;

	/**
	 * Applies everything staged, in the order that leaves the account in the intended state.
	 *
	 * Identity and grants first, because a refusal there should not follow a password that has
	 * already been replaced. Signing out last, because setting a password and forcing a reset each end
	 * every session on their own — running the revocation first would leave the sessions those two
	 * create behind it.
	 *
	 * **Every step names the permit that renders its control**, and names the same flag rather than a
	 * second spelling of it. Not a security check — `panel-action.ts` refuses each of these again and
	 * writes a `DENIED` row, and that is the boundary. It is so the two cannot drift: a control shown
	 * under one condition and sent under another produces a save that aborts partway on a refusal the
	 * operator was never offered a way to avoid.
	 */
	const save = (): void => {
		setError(null);
		startSave(async () => {
			const steps: { when: boolean; run: () => Promise<{ error: string | null }> }[] = [
				{
					// The picture goes first because it is the change most likely to be refused — the server
					// re-decodes the bytes and re-checks the crop — and a refusal there should leave the rest
					// of the form unapplied rather than half-written.
					when: permits.update && pickedFile !== null && stagedCrop !== null,
					run: () => {
						const data = new FormData();
						// Narrowed by the `when` above; the non-null assertions are the price of describing
						// the steps as data rather than as nine nested ifs.
						data.set("file", pickedFile as File);
						data.set("x", String((stagedCrop as CropperValue).x));
						data.set("y", String((stagedCrop as CropperValue).y));
						data.set("size", String((stagedCrop as CropperValue).size));
						return setUserAvatar(account.id, data);
					},
				},
				{
					// `hasAvatar` guards it a second time: only a picture that is actually stored can be
					// removed, and asking the server to remove one that never existed is an error the
					// operator cannot act on.
					when: permits.update && removeAvatar && account.hasAvatar,
					run: () => removeUserAvatar(account.id),
				},
				{ when: permits.update && (nameDirty || emailDirty), run: () => updateUser(account.id, name, email) },
				{ when: permits.grant && rolesDirty, run: () => setUserRoles(account.id, roleIds) },
				{ when: permits.grant && permissionsDirty, run: () => setUserPermissions(account.id, permissions) },
				// `canPromote` and `canLiftBan`, not the bare permits: both fold in the condition the row
				// itself is drawn under, and the point of naming the rendering flag is to name all of it.
				{ when: canPromote && superuserDirty, run: () => setSuperuser(account.id, superuser) },
				{ when: canLiftBan && liftBan, run: () => unbanUser(account.id) },
				{ when: permits.disableTwoFactor && clearTwoFactor, run: () => disableTwoFactor(account.id) },
				{ when: permits.setPassword && newPassword !== "", run: () => setUserPassword(account.id, newPassword) },
				{ when: permits.forceReset && forceReset, run: () => forcePasswordReset(account.id) },
				// Skipped when the whole lot is going anyway, which makes the two controls compose instead
				// of racing: revoking one session that "Sign out everywhere" is about to end is a request
				// for a row the server has already deleted.
				...(signOutAll
					? []
					: revokedSessionIds.map((sessionId) => ({
							when: permits.revokeSessions,
							run: () => revokeUserSession(account.id, sessionId),
						}))),
				{ when: permits.revokeSessions && signOutAll, run: () => revokeUserSessions(account.id) },
			];

			for (const step of steps) {
				if (!step.when) {
					continue;
				}
				const result = await step.run();
				if (result.error) {
					setError(result.error);
					return;
				}
			}

			toast.success(`${account.name} updated.`);
			setOpen(false);
		});
	};

	const roleLabel =
		roleIds.length === 0
			? "No roles"
			: roles
					.filter((role) => roleIds.includes(role.id))
					.map((role) => role.name)
					.join(", ");

	return (
		<>
			{/*
			 * A sibling of the dialog below, never a child, and the two are never open together. The
			 * permission list is fifty checkboxes; opening it on top of this form would bury the form it
			 * belongs to. Rendering it outside `DialogContent` is what makes stepping aside possible at
			 * all — anything nested in the content unmounts the moment this dialog closes, and the
			 * staging held here would go with it.
			 */}
			<PermissionsDialog
				open={permissionsOpen}
				onOpenChange={(nextOpen) => {
					setPermissionsOpen(nextOpen);
					if (!nextOpen) {
						setOpen(true);
					}
				}}
				title={`${account.name}'s permissions`}
				description={
					account.isSuperuser
						? "This account is a superuser and bypasses every check below. These grants apply if it is ever demoted."
						: "Roles and individual grants add together. There is no way to subtract one, so this account can do the union of everything ticked."
				}
				locked={locked}
				value={permissions}
				onApply={setPermissions}
			/>

			{/* Also a sibling, and for the same reason: the crop takes the screen, so this dialog steps
			    aside for it and everything staged here has to survive the round trip. */}
			<AvatarCropDialog
				open={cropOpen}
				onOpenChange={(nextOpen) => {
					setCropOpen(nextOpen);
					if (!nextOpen) {
						setOpen(true);
					}
				}}
				src={pickedUrl}
				onConfirm={(crop, preview) => {
					setStagedCrop(crop);
					setStagedPreview(preview);
				}}
			/>

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogTrigger render={trigger} />
				<DialogContent className="max-h-[88vh] sm:max-w-[820px]">
					{/* `pr-11` reserves the corner for the close button `DialogContent` draws absolutely at
					    `top-2 right-2`; anything on the header's own right edge lands underneath it. */}
					<DialogHeader className="flex-row items-center gap-3 pr-11">
						{/* Follows the staged crop, so the header is the preview and the field below needs no
						    second copy of the same face. */}
						<Avatar src={shownAvatarUrl} initial={account.initial} className="size-10 flex-none" />
						<div className="min-w-0 flex-1">
							<DialogTitle className="flex min-w-0 items-center gap-2">
								<span className="truncate">{account.name}</span>
								{account.isSuperuser ? (
									<Badge variant="outline" className="border-amber-900 bg-amber-950 text-amber-400">
										Superuser
									</Badge>
								) : null}
								{account.banned ? (
									<Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive">
										{account.banExpires ? `Banned until ${formatDate(account.banExpires)}` : "Banned"}
									</Badge>
								) : null}
								{isSelf ? <span className="text-[11.5px] font-normal text-subtle-foreground">you</span> : null}
							</DialogTitle>
							<div className="truncate text-[11.5px] text-subtle-foreground">
								{account.email} · <span className="font-mono">{account.id}</span>
							</div>
						</div>
					</DialogHeader>

					<DialogBody className="gap-6">
						<div className="grid gap-6 md:grid-cols-2">
							<div className="flex min-w-0 flex-col gap-4">
								<SectionLabel>Account</SectionLabel>

								<Field>
									<FieldLabel htmlFor={`manage-name-${account.id}`} className="gap-1.5">
										Name
										{nameDirty ? <DirtyDot /> : null}
									</FieldLabel>
									<Input
										id={`manage-name-${account.id}`}
										value={name}
										disabled={saving || !permits.update}
										onChange={(event) => setName(event.target.value)}
									/>
								</Field>

								<Field>
									<FieldLabel htmlFor={`manage-email-${account.id}`} className="gap-1.5">
										Email
										{emailDirty ? <DirtyDot /> : null}
									</FieldLabel>
									<Input
										id={`manage-email-${account.id}`}
										type="email"
										value={email}
										disabled={saving || !permits.update}
										onChange={(event) => setEmail(event.target.value)}
									/>
								</Field>

								{/*
								 * The same full-width rows the security actions use, for the same reason: these two
								 * stage a change and wait for Save exactly as those do, so a pair of small outline
								 * buttons here said they were a different kind of control. No preview of its own
								 * either — the header is already showing the picture, staged crop included, and a
								 * second copy of the same face would be a duplicate rather than a field.
								 */}
								{permits.update ? (
									// No heading of its own: the icon and the wording say what the rows are for, and
									// a section label over two buttons in the middle of one panel reads as a break
									// where there is no break.
									<div className="flex flex-col gap-2">
										<StagedAction
											icon={<Camera className="size-3.5" />}
											label={shownAvatarUrl ? "Change avatar" : "Choose avatar"}
											staged={stagedPreview !== null}
											disabled={saving}
											onToggle={() => fileInputRef.current?.click()}
										/>
										{shownAvatarUrl ? (
											<StagedAction
												icon={<ImageOff className="size-3.5" />}
												label="Remove avatar"
												staged={removeAvatar}
												disabled={saving}
												onToggle={() => {
													// Two different meanings, told apart the way the profile dialog tells them
													// apart: with a picture staged but unsaved there is nothing on the server
													// the button refers to, so Remove just discards the pick.
													if (stagedPreview) {
														clearStagedAvatar();
														return;
													}
													setRemoveAvatar(true);
												}}
											/>
										) : null}

										<input
											ref={fileInputRef}
											type="file"
											accept="image/png,image/jpeg"
											className="hidden"
											disabled={saving}
											onChange={(event) => choosePicture(event.target.files?.[0] ?? null)}
										/>
									</div>
								) : null}

								{/*
								 * The facts, not the fields. Read-only on purpose: none of these is something an
								 * editor sets — they are what the account has done or had done to it, which is
								 * the half of "who is this" that no input on this screen can answer.
								 *
								 * Status and Last seen are here because they are the two an operator opens this
								 * dialog to check. Last seen comes from the sessions fetched below rather than
								 * from the row, so it reads "—" until they arrive; the row carries a count, not
								 * a clock.
								 */}
								<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-border pt-3 text-[12px]">
									<Fact label="Status">
										{account.banned ? (
											<span className="text-destructive">
												{account.banExpires ? `Banned until ${formatDate(account.banExpires)}` : "Banned"}
											</span>
										) : (
											"Active"
										)}
									</Fact>
									{account.banned && account.banReason ? <Fact label="Ban reason">{account.banReason}</Fact> : null}
									<Fact label="Access">{accessSummary}</Fact>
									<Fact label="Roles">
										{account.roles.length === 0 ? "None" : account.roles.map((role) => role.name).join(", ")}
									</Fact>
									<Fact label="Grants">
										{account.permissions.length === 0
											? "None"
											: account.permissions.length === 1
												? "1 individual"
												: `${account.permissions.length} individual`}
									</Fact>
									<Fact label="Two-factor">{account.twoFactorEnabled ? "Enrolled" : "Not enrolled"}</Fact>
									<Fact label="Password">{account.mustChangePassword ? "Reset due" : "Set"}</Fact>
									<Fact label="Sessions">{account.sessionCount === 1 ? "1 open" : `${account.sessionCount} open`}</Fact>
									<Fact label="Last seen">{lastSeen === null ? "—" : formatDateTime(lastSeen)}</Fact>
									<Fact label="Created">{formatDateTime(account.createdAt)}</Fact>
								</dl>
							</div>

							<div className="flex min-w-0 flex-col gap-4">
								{permits.grant ? (
									<div className="flex flex-col gap-2">
										{/* A plain span, not a `<label>`: a Base UI select's trigger is not a form control a
										    `for` can point at, and a label naming nothing is worse than no label element. */}
										<span className="flex items-center gap-1.5">
											<SectionLabel>Roles</SectionLabel>
											{rolesDirty ? <DirtyDot /> : null}
										</span>
										{roles.length === 0 ? (
											<p className="text-[11.5px] text-subtle-foreground">No roles yet. Create one on the Roles tab.</p>
										) : (
											<Select
												multiple
												value={roleIds}
												disabled={saving}
												onValueChange={(next) => setRoleIds(next as string[])}
											>
												{/* The trigger draws its own text rather than `SelectValue`: with `multiple` the
												    value is an array of ids, and an id is not what anyone came here to read. */}
												<SelectTrigger className="h-9 w-full">
													<span className={cn("truncate", roleIds.length === 0 && "text-muted-foreground")}>
														{roleLabel}
													</span>
												</SelectTrigger>
												<SelectContent>
													{roles.map((role) => {
														const mine = assignable.some((candidate) => candidate.id === role.id);
														return (
															<SelectItem key={role.id} value={role.id} disabled={!mine}>
																{role.name}
																{mine ? null : (
																	<span className="ml-2 text-[11px] text-subtle-foreground">
																		carries more than you hold
																	</span>
																)}
															</SelectItem>
														);
													})}
												</SelectContent>
											</Select>
										)}

										{/* Beside the roles rather than at the foot of the dialog: roles and individual
										    grants add together, so the two answer the same question. */}
										<Button
											type="button"
											variant="outline"
											size="sm"
											className="justify-start"
											disabled={saving}
											onClick={() => {
												returningFromPermissions.current = true;
												setPermissionsOpen(true);
												setOpen(false);
											}}
										>
											<SlidersHorizontal className="size-3.5" />
											Individual permissions
											<span className="ml-auto text-[11px] text-subtle-foreground">
												{permissions.length === 0 ? "none" : `${permissions.length} granted`}
											</span>
											{permissionsDirty ? <DirtyDot /> : null}
										</Button>
									</div>
								) : null}

								{permits.setPassword || permits.forceReset || permits.disableTwoFactor || permits.revokeSessions ? (
									<div className="flex flex-col gap-2">
										<SectionLabel>Security actions</SectionLabel>

										{permits.setPassword ? (
											<div
												className={cn(
													"flex flex-col gap-2 rounded-lg border px-3 py-2.5 transition-colors",
													newPassword === "" ? "border-border bg-muted/30" : "border-brand/50 bg-brand/5",
												)}
											>
												<div className="flex items-center gap-2 text-[12.5px]">
													<KeyRound className="size-3.5 shrink-0 text-subtle-foreground" />
													Set a new password
													{newPassword === "" ? null : <DirtyDot />}
												</div>
												<Input
													type="password"
													value={newPassword}
													disabled={saving}
													placeholder="Leave empty to keep the current one"
													className="h-8 text-[12px]"
													onChange={(event) => setNewPassword(event.target.value)}
												/>
											</div>
										) : null}

										{permits.forceReset ? (
											<StagedAction
												icon={<TimerReset className="size-3.5" />}
												label="Force password reset"
												staged={forceReset}
												disabled={saving || account.mustChangePassword}
												state={account.mustChangePassword ? "already due" : undefined}
												onToggle={() => setForceReset((current) => !current)}
											/>
										) : null}

										{permits.disableTwoFactor ? (
											<StagedAction
												icon={<ShieldOff className="size-3.5" />}
												label="Clear two-factor enrolment"
												staged={clearTwoFactor}
												disabled={saving || !account.twoFactorEnabled}
												state={account.twoFactorEnabled ? "enrolled" : "not enrolled"}
												onToggle={() => setClearTwoFactor((current) => !current)}
											/>
										) : null}

										{permits.revokeSessions ? (
											<StagedAction
												icon={<LogOut className="size-3.5" />}
												label="Sign out everywhere"
												staged={signOutAll}
												disabled={saving || sessions === null || sessions.length === 0}
												state={sessions === null ? "…" : `${sessions.length} active`}
												onToggle={() => setSignOutAll((current) => !current)}
											/>
										) : null}
									</div>
								) : null}

								{showDanger ? (
									<div className="flex flex-col gap-2">
										<SectionLabel destructive>Danger zone</SectionLabel>

										{/* The label names the action, not the state. It read "Superuser" on an account
										    that already was one — a heading where a verb belongs, which left no way to
										    demote anybody. What the account *is* goes in `state` on the right, where
										    every other row puts its own. */}
										{canPromote ? (
											<StagedAction
												destructive
												label={account.isSuperuser ? "Demote from superuser" : "Promote to superuser"}
												hint={
													account.isSuperuser
														? "They keep whatever roles and individual grants they hold, and nothing more."
														: "Bypasses every permission check, including ones nobody can grant."
												}
												staged={superuserDirty}
												disabled={saving}
												state={account.isSuperuser ? "superuser" : undefined}
												onToggle={() => setSuperuserStaged((current) => !current)}
											/>
										) : null}

										{canLiftBan ? (
											<StagedAction
												destructive
												label="Lift the ban"
												staged={liftBan}
												disabled={saving}
												onToggle={() => setLiftBan((current) => !current)}
											/>
										) : null}

										{/* Ban and Delete are the two that are not staged, for two different reasons —
										    see this component's own note. */}
										{canBan ? <BanAction accountName={account.name} disabled={saving} userId={account.id} /> : null}

										{canDelete ? (
											<DeleteAction
												accountName={account.name}
												disabled={saving}
												onDeleted={() => setOpen(false)}
												userId={account.id}
											/>
										) : null}
									</div>
								) : null}
							</div>
						</div>

						{permits.revokeSessions ? (
							<div className="border-t border-border pt-4">
								<SectionLabel>Open sessions</SectionLabel>
								<p className="mt-1 mb-3 text-[11.5px] text-subtle-foreground">
									Sessions are rows rather than self-contained tokens, so revoking one ends it the moment you save
									rather than when it would have expired.
								</p>
								{sessions === null ? (
									<Spinner className="size-4" />
								) : sessions.length === 0 ? (
									<p className="text-[12px] text-subtle-foreground">No sessions open.</p>
								) : (
									// A real table rather than a stack of rows: bordered, with a tinted head, so the
									// rows read as a list of records instead of dissolving into the dialog behind them.
									<div className="overflow-hidden rounded-lg border border-border">
										<Table>
											<TableHeader className="bg-card-band">
												<TableRow className="hover:bg-transparent">
													<TableHead className="h-8 px-3 text-[10.5px] tracking-[0.06em] text-subtle-foreground uppercase">
														Last seen
													</TableHead>
													<TableHead className="h-8 px-3 text-[10.5px] tracking-[0.06em] text-subtle-foreground uppercase">
														Address
													</TableHead>
													<TableHead className="h-8 px-3 text-[10.5px] tracking-[0.06em] text-subtle-foreground uppercase">
														Device
													</TableHead>
													<TableHead className="h-8 w-[88px] px-3" />
												</TableRow>
											</TableHeader>
											<TableBody>
												{sessions.map((session) => {
													// A staged sign-out covers every session, so each row reads as going with
													// it — otherwise the list would invite staging the same thing twice.
													const staged = signOutAll || revokedSessionIds.includes(session.id);
													return (
														<TableRow key={session.id} className={cn(staged && "opacity-50")}>
															<TableCell className={cn("px-3 text-[12px] tabular-nums", staged && "line-through")}>
																{formatDateTime(session.updatedAt)}
															</TableCell>
															<TableCell className={cn("px-3 font-mono text-[12px]", staged && "line-through")}>
																{session.ipAddress ?? "unknown"}
															</TableCell>
															<TableCell className="max-w-[280px] truncate px-3 text-[12px] text-subtle-foreground">
																{session.userAgent ?? "unknown"}
															</TableCell>
															<TableCell className="px-3 text-right">
																<Button
																	type="button"
																	variant="ghost"
																	size="sm"
																	disabled={saving || signOutAll}
																	onClick={() =>
																		setRevokedSessionIds((current) =>
																			current.includes(session.id)
																				? current.filter((entry) => entry !== session.id)
																				: [...current, session.id],
																		)
																	}
																>
																	{revokedSessionIds.includes(session.id) ? "Keep" : "Revoke"}
																</Button>
															</TableCell>
														</TableRow>
													);
												})}
											</TableBody>
										</Table>
									</div>
								)}
							</div>
						) : null}

						{error ? (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
					</DialogBody>

					<DialogFooter>
						{dirtyCount > 0 ? (
							<span className="mr-auto text-[12.5px] text-muted-foreground">
								{dirtyCount === 1 ? "1 unsaved change" : `${dirtyCount} unsaved changes`}
							</span>
						) : null}
						<Button type="button" variant="ghost" disabled={saving || dirtyCount === 0} onClick={reset}>
							Discard
						</Button>
						<Button
							type="button"
							disabled={saving || dirtyCount === 0 || name.trim() === "" || email.trim() === ""}
							onClick={save}
						>
							{saving ? <Spinner className="size-3.5" /> : null}
							Save changes
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

/** A small caps heading, the one thing that tells the halves of this dialog apart. */
function SectionLabel({ children, destructive = false }: { children: ReactNode; destructive?: boolean }) {
	return (
		<span
			className={cn(
				"text-[10.5px] font-medium tracking-[0.08em] uppercase",
				destructive ? "text-destructive" : "text-subtle-foreground",
			)}
		>
			{children}
		</span>
	);
}

/** One `label: value` line in the read-only facts list. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-subtle-foreground">{label}</dt>
			<dd className="min-w-0 truncate">{children}</dd>
		</>
	);
}

/**
 * The one row shape every action on this screen wears.
 *
 * A function rather than four copies of the same class string, because the four rows that use it
 * have to be indistinguishable: the Danger zone read as a section with a stray neutral button in it
 * while promoting and lifting a ban were styled one way and banning and deleting another, and the
 * only thing that difference communicated was which of them happened to be a `<button>` and which a
 * dialog trigger — which is not a distinction an operator has any use for.
 *
 * @param destructive whether the row belongs to the Danger zone
 * @param staged whether the change is armed and waiting for Save
 */
function actionRowClass({ destructive, staged }: { destructive: boolean; staged: boolean }): string {
	return cn(
		"flex w-full flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
		"disabled:pointer-events-none disabled:opacity-50",
		destructive
			? staged
				? "border-destructive bg-destructive/15 text-destructive"
				: "border-destructive/40 text-destructive hover:bg-destructive/10"
			: staged
				? "border-brand/50 bg-brand/5"
				: "border-border bg-muted/30 hover:bg-muted/60",
	);
}

/**
 * One action that arms rather than fires.
 *
 * Clicking it stages the change and tints the row; clicking again disarms it. The state on the right
 * is what the account is *now* — "not enrolled", "3 active" — which is the reason this is a row and
 * not a bare button: an action that would do nothing to this account is disabled and says why,
 * rather than being hidden and leaving the operator unsure the control exists.
 */
function StagedAction({
	icon,
	label,
	hint,
	state,
	staged,
	disabled,
	destructive = false,
	onToggle,
}: {
	icon?: ReactElement;
	label: string;
	hint?: string;
	state?: string;
	staged: boolean;
	disabled: boolean;
	destructive?: boolean;
	onToggle: () => void;
}) {
	return (
		<button type="button" disabled={disabled} onClick={onToggle} className={actionRowClass({ destructive, staged })}>
			<span className="flex w-full items-center gap-2 text-[12.5px]">
				{icon ? (
					<span className={cn("shrink-0", destructive ? "text-destructive/70" : "text-subtle-foreground")}>{icon}</span>
				) : null}
				<span className="min-w-0 flex-1 truncate">{label}</span>
				{staged ? <DirtyDot /> : null}
				{state ? (
					<span
						className={cn(
							"shrink-0 text-[10.5px] tracking-[0.06em] uppercase",
							destructive ? "text-destructive/70" : "text-subtle-foreground",
						)}
					>
						{state}
					</span>
				) : null}
			</span>
			{hint ? (
				<span className={cn("text-[11px]", destructive ? "text-destructive/70" : "text-subtle-foreground")}>
					{hint}
				</span>
			) : null}
		</button>
	);
}

/**
 * Banning, which needs a reason and an optional expiry rather than a switch.
 *
 * A reason is required and the service refuses an empty one: a ban is read months later by somebody
 * deciding whether to lift it, and a row that says only "banned" cannot be acted on.
 */
function BanAction({ userId, accountName, disabled }: { userId: string; accountName: string; disabled: boolean }) {
	const [open, setOpen] = useState(false);
	const [reason, setReason] = useState("");
	const [until, setUntil] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, startSave] = useTransition();

	const save = (): void => {
		setError(null);
		startSave(async () => {
			// The picker gives a bare `YYYY-MM-DD`, which parses as midnight UTC. The ban lifts at the
			// start of that day rather than the end of the previous one, which is what an operator
			// picking a date means.
			const expiresAt = until === "" ? null : new Date(`${until}T00:00:00Z`).toISOString();
			const result = await banUser(userId, reason, expiresAt);
			if (result.error) {
				setError(result.error);
				return;
			}
			toast.success(`${accountName} banned. Their sessions have ended.`);
			setOpen(false);
		});
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				setReason("");
				setUntil("");
				setError(null);
			}}
		>
			<DialogTrigger
				disabled={disabled}
				render={<button type="button" className={actionRowClass({ destructive: true, staged: false })} />}
			>
				{/* The same inner row `StagedAction` draws, so this trigger and the staged rows beside it
				    are the same object to look at. */}
				<span className="flex w-full items-center gap-2 text-[12.5px]">
					<span className="min-w-0 flex-1 truncate">Ban account</span>
				</span>
			</DialogTrigger>
			<DialogContent className="sm:max-w-[440px]">
				<DialogHeader>
					<DialogTitle>Ban {accountName}</DialogTitle>
				</DialogHeader>
				<DialogBody>
					<p className="text-[12px] text-subtle-foreground">
						Their sessions end now and they cannot sign in again. The account, its grants and its history are kept.
					</p>
					<Field>
						<FieldLabel htmlFor={`ban-reason-${userId}`}>Reason</FieldLabel>
						<Input
							id={`ban-reason-${userId}`}
							value={reason}
							disabled={saving}
							placeholder="Left the company"
							onChange={(event) => setReason(event.target.value)}
						/>
					</Field>
					<Field>
						{/* A span rather than `FieldLabel htmlFor`: the picker's trigger is a button, and a
						    `for` pointing at one names nothing. Its own `label` is what a screen reader reads. */}
						<span className="text-sm leading-none font-medium select-none">Lifts on</span>
						<DatePicker
							clearable
							disabled={saving}
							id={`ban-until-${userId}`}
							label="Ban lifts on"
							placeholder="Never — until lifted by hand"
							value={until}
							onChange={setUntil}
						/>
					</Field>
					{error ? (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
				</DialogBody>
				<DialogFooter>
					<Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button type="button" variant="destructive" disabled={saving || reason.trim() === ""} onClick={save}>
						{saving ? <Spinner className="size-3.5" /> : null}
						Ban account
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Deleting, which keeps its confirmation.
 *
 * It is the one action here that cannot be staged: it destroys the thing being edited, so there is
 * no account left for Save changes to apply the rest of the form to.
 */
function DeleteAction({
	userId,
	accountName,
	disabled,
	onDeleted,
}: {
	userId: string;
	accountName: string;
	disabled: boolean;
	onDeleted: () => void;
}) {
	const [pending, startTransition] = useTransition();

	return (
		<AlertDialog>
			<AlertDialogTrigger
				disabled={disabled || pending}
				render={<button type="button" className={actionRowClass({ destructive: true, staged: false })} />}
			>
				<span className="flex w-full items-center gap-2 text-[12.5px]">
					<span className="min-w-0 flex-1 truncate">Delete account</span>
				</span>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete {accountName}?</AlertDialogTitle>
					<AlertDialogDescription>
						Their sessions, credential, roles and grants go with them. What they did stays in the audit record, which
						nothing here can erase.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={() =>
							startTransition(async () => {
								const result = await deleteUser(userId);
								if (result.error) {
									toast.error(result.error);
									return;
								}
								toast.success(`${accountName} deleted.`);
								onDeleted();
							})
						}
					>
						Delete
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
