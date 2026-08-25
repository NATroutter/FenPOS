"use client";

import { type ReactElement, useState, useTransition } from "react";
import { toast } from "sonner";
import { setUserPermissions, setUserRoles } from "@/app/(panel)/users/actions";
import type { UserRowData } from "@/app/(panel)/users/user-row";
import { type LockedPermission, PermissionChecklist } from "@/components/panel/permission-checklist";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import type { PanelPermission } from "@/lib/domain/panel-permissions";

/** A role as the account dialogs list it, with what it carries so the form can lock what it confers. */
export interface GrantableRole {
	id: string;
	name: string;
	permissions: string[];
}

/**
 * What one account holds: its roles, and its own individual grants.
 *
 * **Role-derived permissions render locked with the role named beside them.** That is the whole
 * reason roles and grants are edited on one screen rather than two: "why does this person have this"
 * is answerable at a glance instead of by cross-referencing.
 *
 * **So do grants the editor has no authority over**, with a different reason beside them. Those are
 * not hidden, because an account's authority is not answerable from a form that omits half of it,
 * and they are not editable, because they were never this editor's to give or to take —
 * `grant-service.ts` retains them whatever this form sends.
 *
 * Two actions rather than one, because roles and individual grants are the same permission
 * (`users:grant`) but two registry entries, and a record that says which of them changed is worth
 * more than one that cannot tell.
 */
export function GrantDialog({
	account,
	roles,
	editorHolds,
	trigger,
}: {
	account: UserRowData;
	roles: GrantableRole[];
	editorHolds: string[];
	trigger: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	const [roleIds, setRoleIds] = useState<string[]>(account.roles.map((role) => role.id));
	const [permissions, setPermissions] = useState<string[]>(account.permissions);
	const [error, setError] = useState<string | null>(null);
	const [saving, startSave] = useTransition();

	const toggle = (list: string[], value: string): string[] =>
		list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

	const assignable = roles.filter((role) => role.permissions.every((permission) => editorHolds.includes(permission)));

	// Two reasons a checkbox is locked, and they say different things. A role's own permission is
	// not this account's grant to remove here; a permission the editor does not hold is not theirs
	// to touch at all.
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

	const save = (): void => {
		setError(null);
		startSave(async () => {
			const roleResult = await setUserRoles(account.id, roleIds);
			if (roleResult.error) {
				setError(roleResult.error);
				return;
			}
			const grantResult = await setUserPermissions(account.id, permissions);
			if (grantResult.error) {
				setError(grantResult.error);
				return;
			}
			toast.success(`${account.name} updated.`);
			setOpen(false);
		});
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) {
					setError(null);
					setRoleIds(account.roles.map((role) => role.id));
					setPermissions(account.permissions);
				}
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-[560px]">
				<DialogHeader>
					<DialogTitle>{account.name}&apos;s access</DialogTitle>
					<DialogDescription>
						{account.isSuperuser
							? "This account is a superuser and bypasses every check below. These grants apply if it is ever demoted."
							: "Roles and individual grants add together. There is no way to subtract one, so an account can do the union of everything below."}
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="flex flex-col gap-4">
						<div className="flex flex-col gap-2.5">
							<span className="text-[12.5px] font-medium">Roles</span>
							{roles.length === 0 ? (
								<p className="text-[11.5px] text-subtle-foreground">No roles yet. Create one on the Roles tab.</p>
							) : (
								roles.map((role) => {
									const mine = assignable.some((candidate) => candidate.id === role.id);
									return (
										<div key={role.id} className="flex items-center gap-2.5">
											<Checkbox
												id={`grant-role-${role.id}`}
												checked={roleIds.includes(role.id)}
												disabled={saving || !mine}
												onCheckedChange={() => setRoleIds((current) => toggle(current, role.id))}
											/>
											<FieldLabel htmlFor={`grant-role-${role.id}`} className="cursor-pointer font-normal">
												{role.name}
												{mine ? null : (
													<span className="ml-2 text-[11px] text-subtle-foreground">carries more than you hold</span>
												)}
											</FieldLabel>
										</div>
									);
								})
							)}
						</div>

						<div className="border-t border-border pt-3">
							<PermissionChecklist
								selected={permissions}
								locked={locked}
								disabled={saving}
								onToggle={(permission: PanelPermission) => setPermissions((current) => toggle(current, permission))}
							/>
						</div>

						{error ? (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
					</div>
				</DialogBody>
				<DialogFooter>
					<Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button type="button" disabled={saving} onClick={save}>
						{saving ? <Spinner className="size-3.5" /> : null}
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
