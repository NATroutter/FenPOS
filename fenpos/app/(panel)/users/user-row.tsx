"use client";

import {
	Camera,
	KeyRound,
	MonitorSmartphone,
	ShieldCheck,
	ShieldOff,
	TimerReset,
	Trash2,
	UserCog,
	UserX,
} from "lucide-react";
import type { ComponentProps, ReactElement } from "react";
import { useTransition } from "react";
import { toast } from "sonner";
import { AvatarDialog } from "@/app/(panel)/settings/avatar-dialog";
import {
	deleteUser,
	disableTwoFactor,
	forcePasswordReset,
	removeUserAvatar,
	setSuperuser,
	setUserAvatar,
	unbanUser,
} from "@/app/(panel)/users/actions";
import { BanDialog } from "@/app/(panel)/users/ban-dialog";
import { type GrantableRole, GrantDialog } from "@/app/(panel)/users/grant-dialog";
import { PasswordDialog } from "@/app/(panel)/users/password-dialog";
import { SessionsDialog } from "@/app/(panel)/users/sessions-dialog";
import { UserDialog } from "@/app/(panel)/users/user-dialog";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardActions, CardContent, CardHeader } from "@/components/ui/card";
import { formatDate, formatDateTime } from "@/lib/format/datetime";

/** An account as this component needs it, serialised for the client boundary. */
export interface UserRowData {
	id: string;
	name: string;
	email: string;
	/**
	 * The letter shown in place of an avatar.
	 *
	 * Derived on the server rather than here, because `lib/auth/avatar.ts` imports `node:crypto` for
	 * its other export and importing it from a client component would pull that into the browser
	 * bundle. Phase 7 replaces this with real image bytes.
	 */
	initial: string;
	/**
	 * Whether the account already has a stored avatar.
	 *
	 * Ids-only plumbing from `usersWithAvatars`, not the picture itself — drawing the picture is
	 * `avatarUrl`'s job, which a later task adds. This much is enough to word the avatar control's
	 * own copy ("Set" versus "Change").
	 */
	hasAvatar: boolean;
	isSuperuser: boolean;
	mustChangePassword: boolean;
	banned: boolean;
	banReason: string | null;
	banExpires: string | null;
	twoFactorEnabled: boolean;
	createdAt: string;
	roles: { id: string; name: string }[];
	permissions: string[];
	sessionCount: number;
}

/** Which row actions to render. Convenience only — every action checks again. */
export interface UserPermits {
	create: boolean;
	update: boolean;
	setPassword: boolean;
	forceReset: boolean;
	ban: boolean;
	unban: boolean;
	revokeSessions: boolean;
	remove: boolean;
	grant: boolean;
	disableTwoFactor: boolean;
	setSuperuser: boolean;
}

/**
 * One account: who it is, what it holds, and what can be done about it.
 *
 * An account with no roles and no grants is called out rather than left to be inferred from two
 * empty lists — inert is the correct default for a new account, and it is also what a
 * half-configured one looks like. Only the operator can tell which.
 *
 * The actions aimed at the acting account itself are not rendered: banning and deleting yourself are
 * refused in the service, and offering a button whose only outcome is that refusal is worse than
 * offering none.
 */
export function UserRow({
	account,
	roles,
	editorHolds,
	actingUserId,
	permits,
}: {
	account: UserRowData;
	roles: GrantableRole[];
	editorHolds: string[];
	actingUserId: string;
	permits: UserPermits;
}) {
	const [pending, startTransition] = useTransition();
	const isSelf = account.id === actingUserId;

	const act = (label: string, action: () => Promise<{ error: string | null }>): void => {
		startTransition(async () => {
			const result = await action();
			if (result.error) {
				toast.error(result.error);
			} else {
				toast.success(label);
			}
		});
	};

	return (
		<Card className={account.banned ? "opacity-60" : undefined}>
			<CardHeader className="flex flex-row flex-wrap items-center gap-3 border-b border-border pb-3">
				<span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-[13px] font-medium">
					{account.initial}
				</span>
				<div className="min-w-0 flex-1">
					<div className="truncate text-[13.5px] font-medium">
						{account.name}
						{isSelf ? <span className="ml-2 text-[11.5px] text-subtle-foreground">you</span> : null}
					</div>
					<div className="mt-0.5 truncate text-[11.5px] text-subtle-foreground">{account.email}</div>
				</div>

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
				{account.mustChangePassword ? (
					<Badge variant="outline" className="border-border">
						Password reset due
					</Badge>
				) : null}
			</CardHeader>

			<CardContent className="flex flex-col gap-4 pt-4">
				<div className="grid gap-3 sm:grid-cols-2">
					<Held label="Roles" values={account.roles.map((role) => role.name)} empty="None." />
					<Held
						label="Individual permissions"
						values={account.permissions}
						empty={
							account.roles.length === 0 && !account.isSuperuser ? "None — this account cannot do anything." : "None."
						}
					/>
				</div>

				{account.banned && account.banReason ? (
					<p className="text-[11.5px] text-subtle-foreground">Ban reason: {account.banReason}</p>
				) : null}

				<CardActions>
					<span className="text-[11.5px] text-subtle-foreground">
						Created {formatDateTime(account.createdAt)} ·{" "}
						{account.sessionCount === 1 ? "1 session" : `${account.sessionCount} sessions`}
						{account.twoFactorEnabled ? " · two-factor on" : ""}
					</span>

					<div className="flex-1" />

					{permits.update ? (
						<UserDialog
							roles={roles}
							editorHolds={editorHolds}
							userId={account.id}
							initialName={account.name}
							initialEmail={account.email}
							trigger={<IconButton title="Edit account" icon={<UserCog className="size-3.5" />} />}
						/>
					) : null}

					{/*
					 * Gated on the same permission as the edit button above, deliberately: setting somebody
					 * else's avatar is `users:update` too, not a free pass like the caller's own picture on
					 * Settings — see the registry's own note on `users:set-avatar`.
					 */}
					{permits.update ? (
						<AvatarDialog
							onSave={(formData) => setUserAvatar(account.id, formData)}
							onRemove={() => removeUserAvatar(account.id)}
							trigger={
								<IconButton
									title={account.hasAvatar ? "Change avatar" : "Set avatar"}
									icon={<Camera className="size-3.5" />}
								/>
							}
						/>
					) : null}

					{permits.grant ? (
						<GrantDialog
							account={account}
							roles={roles}
							editorHolds={editorHolds}
							trigger={<IconButton title="Roles and permissions" icon={<ShieldCheck className="size-3.5" />} />}
						/>
					) : null}

					{permits.setPassword ? (
						<PasswordDialog
							userId={account.id}
							accountName={account.name}
							trigger={<IconButton title="Set password" icon={<KeyRound className="size-3.5" />} />}
						/>
					) : null}

					{permits.forceReset && !account.mustChangePassword ? (
						<Confirm
							title={`Require ${account.name} to reset their password?`}
							description="Their sessions end now, and they cannot reach anything but the page that takes a new password."
							confirmLabel="Require reset"
							disabled={pending}
							onConfirm={() => act("Password reset required.", () => forcePasswordReset(account.id))}
							trigger={<IconButton title="Force password reset" icon={<TimerReset className="size-3.5" />} />}
						/>
					) : null}

					{permits.revokeSessions && account.sessionCount > 0 ? (
						<SessionsDialog
							userId={account.id}
							accountName={account.name}
							trigger={<IconButton title="Sessions" icon={<MonitorSmartphone className="size-3.5" />} />}
						/>
					) : null}

					{permits.disableTwoFactor && account.twoFactorEnabled ? (
						<Confirm
							title={`Clear ${account.name}'s two-factor enrolment?`}
							description="They sign in with their password alone until they enrol again."
							confirmLabel="Clear"
							disabled={pending}
							onConfirm={() => act("Two-factor cleared.", () => disableTwoFactor(account.id))}
							trigger={<IconButton title="Clear two-factor" icon={<ShieldOff className="size-3.5" />} />}
						/>
					) : null}

					{permits.setSuperuser && !isSelf ? (
						<Confirm
							title={account.isSuperuser ? `Demote ${account.name}?` : `Promote ${account.name} to superuser?`}
							description={
								account.isSuperuser
									? "They keep whatever roles and individual grants they hold, and nothing more."
									: "A superuser bypasses every permission check, including ones nobody can grant."
							}
							confirmLabel={account.isSuperuser ? "Demote" : "Promote"}
							disabled={pending}
							onConfirm={() =>
								act(account.isSuperuser ? "Demoted." : "Promoted.", () =>
									setSuperuser(account.id, !account.isSuperuser),
								)
							}
							trigger={
								<IconButton
									title={account.isSuperuser ? "Demote" : "Promote to superuser"}
									icon={<ShieldCheck className="size-3.5" />}
								/>
							}
						/>
					) : null}

					{permits.unban && account.banned ? (
						<Confirm
							title={`Lift the ban on ${account.name}?`}
							description="They can sign in again immediately."
							confirmLabel="Lift ban"
							disabled={pending}
							onConfirm={() => act("Ban lifted.", () => unbanUser(account.id))}
							trigger={<IconButton title="Lift ban" icon={<ShieldCheck className="size-3.5" />} />}
						/>
					) : null}

					{permits.ban && !account.banned && !isSelf ? (
						<BanDialog
							userId={account.id}
							accountName={account.name}
							trigger={<IconButton title="Ban" destructive icon={<UserX className="size-3.5" />} />}
						/>
					) : null}

					{permits.remove && !isSelf ? (
						<Confirm
							title={`Delete ${account.name}?`}
							description="Their sessions, credential, roles and grants go with them. What they did stays in the audit record, which nothing here can erase."
							confirmLabel="Delete"
							disabled={pending}
							onConfirm={() => act(`${account.name} deleted.`, () => deleteUser(account.id))}
							trigger={<IconButton title="Delete account" destructive icon={<Trash2 className="size-3.5" />} />}
						/>
					) : null}
				</CardActions>
			</CardContent>
		</Card>
	);
}

/** One list of what an account holds, or a plain statement that there is none. */
function Held({ label, values, empty }: { label: string; values: string[]; empty: string }) {
	return (
		<div className="min-w-0">
			<div className="text-[11px] font-medium text-subtle-foreground">{label}</div>
			{values.length === 0 ? (
				<p className="mt-1 text-[11.5px] text-amber-400">{empty}</p>
			) : (
				<div className="mt-1.5 flex flex-wrap gap-1.5">
					{values.map((value) => (
						<Badge key={value} variant="outline" className="font-mono text-[11px]">
							{value}
						</Badge>
					))}
				</div>
			)}
		</div>
	);
}

/**
 * One square action button, labelled for a pointer and for a screen reader alike.
 *
 * **Everything else is spread onto the `Button`, and that is load-bearing.** Both `DialogTrigger`
 * and `AlertDialogTrigger` take this element through their `render` prop and clone it with the
 * handlers and ARIA state that make a trigger work. A wrapper that read only its own three props
 * dropped all of that on the floor: the button rendered, looked right, and did nothing at all when
 * clicked — which is exactly what it did before this spread was added.
 */
function IconButton({
	title,
	icon,
	destructive = false,
	...rest
}: ComponentProps<typeof Button> & {
	title: string;
	icon: ReactElement;
	destructive?: boolean;
}) {
	return (
		<Button
			variant="outline"
			size="icon"
			className={destructive ? "size-8 border-destructive/40 text-destructive hover:bg-destructive/10" : "size-8"}
			title={title}
			aria-label={title}
			{...rest}
		>
			{icon}
		</Button>
	);
}

/** A destructive action behind a confirmation. */
function Confirm({
	title,
	description,
	confirmLabel,
	disabled,
	onConfirm,
	trigger,
}: {
	title: string;
	description: string;
	confirmLabel: string;
	disabled: boolean;
	onConfirm: () => void;
	trigger: ReactElement;
}) {
	return (
		<AlertDialog>
			<AlertDialogTrigger disabled={disabled} render={trigger} />
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
