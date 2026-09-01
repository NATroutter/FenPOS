"use client";

import { SlidersHorizontal, Trash2 } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { deleteRole, updateRole } from "@/app/(panel)/roles/actions";
import type { RolePermits, RoleRowData } from "@/app/(panel)/roles/role-data";
import { DirtyDot } from "@/components/panel/dirty-dot";
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
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

/** Whether two lists hold the same ids, order aside. */
function sameSet(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((entry) => right.includes(entry));
}

/**
 * Everything about one role, on one screen, committed by one button.
 *
 * It borrows the account dialog's *habits* — staged edits, dirty dots, a footer that counts what is
 * outstanding, the permission list behind a button rather than poured into the form — and none of
 * its shape. That dialog is two columns because an account is three unrelated things at once; a role
 * is three fields about one thing, and laying those out in two columns would leave half of each
 * empty and invite the reader to work out why the sides are separate.
 *
 * **Membership is not here.** Who is in a role is set from the Users tab, on the screen that asks
 * "what does this person hold" — one place to look rather than two that have to agree.
 *
 * **Nothing here fires when it is clicked.** Name, description and permissions are staged and
 * written by Save changes. **Delete** is the one exception, for the reason it is on the account
 * screen: it ends the thing being edited, so there is nothing left for Save to apply the rest to.
 */
export function ManageRoleDialog({
	role,
	editorHolds,
	permits,
	trigger,
}: {
	role: RoleRowData;
	editorHolds: string[];
	permits: RolePermits;
	trigger: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	const [permissionsOpen, setPermissionsOpen] = useState(false);

	const [name, setName] = useState(role.name);
	const [description, setDescription] = useState(role.description ?? "");
	const [permissions, setPermissions] = useState<string[]>(role.permissions);

	const [error, setError] = useState<string | null>(null);
	const [saving, startSave] = useTransition();

	const reset = (): void => {
		setName(role.name);
		setDescription(role.description ?? "");
		setPermissions(role.permissions);
		setError(null);
	};

	/** Set while the permissions dialog has taken this one's place — see the account dialog's own note. */
	const returningFromPermissions = useRef(false);

	useEffect(() => {
		if (!open) {
			return;
		}
		if (returningFromPermissions.current) {
			returningFromPermissions.current = false;
			return;
		}
		// Keyed on the role and the open flag alone: `reset` is recreated every render, so depending on
		// it would re-run this on every keystroke and make the form impossible to type in.
		reset();
	}, [open, role]);

	const nameDirty = name !== role.name;
	const descriptionDirty = description !== (role.description ?? "");
	const permissionsDirty = !sameSet(permissions, role.permissions);

	const dirtyCount = Number(nameDirty) + Number(descriptionDirty) + Number(permissionsDirty);

	/**
	 * What this role would give that the editor does not hold themselves.
	 *
	 * Shown rather than hidden, and shown *before* Save rather than as a refusal after it: the
	 * permission list is the same for every viewer so two colleagues can compare screens, and the
	 * service refuses the submission either way. This is what stops the operator finding that out by
	 * pressing the button.
	 */
	const beyond = permissions.filter((permission) => !editorHolds.includes(permission));

	const save = (): void => {
		setError(null);
		startSave(async () => {
			// Membership is not edited here — it belongs to the Users tab, where "what does this person
			// hold" is the question being asked. The service replaces the member list wholesale, so the
			// current one is sent back unchanged rather than omitted: omitting it would empty the role.
			const result = await updateRole(role.id, {
				name,
				description,
				permissions,
				memberIds: role.members.map((member) => member.id),
			});
			if (result.error) {
				setError(result.error);
				return;
			}
			toast.success(`${role.name} updated.`);
			setOpen(false);
		});
	};

	return (
		<>
			<PermissionsDialog
				open={permissionsOpen}
				onOpenChange={(nextOpen) => {
					setPermissionsOpen(nextOpen);
					if (!nextOpen) {
						setOpen(true);
					}
				}}
				title={`${role.name}'s permissions`}
				description="Everyone in this role gets everything ticked here, the moment you save. That is what a role is for."
				locked={[]}
				value={permissions}
				onApply={setPermissions}
			/>

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogTrigger render={trigger} />
				{/*
				 * One column, and narrow — see this component's own note for why. */}
				<DialogContent className="max-h-[88vh] sm:max-w-[520px]">
					<DialogHeader className="pr-11">
						<DialogTitle className="truncate">{role.name}</DialogTitle>
						<div className="truncate text-[11.5px] text-subtle-foreground">
							{role.members.length === 0
								? "Nobody is in this role"
								: role.members.length === 1
									? "1 member"
									: `${role.members.length} members`}{" "}
							· <span className="font-mono">{role.id}</span>
						</div>
					</DialogHeader>

					<DialogBody>
						<Field>
							<FieldLabel htmlFor={`role-name-${role.id}`} className="gap-1.5">
								Name
								{nameDirty ? <DirtyDot /> : null}
							</FieldLabel>
							<Input
								id={`role-name-${role.id}`}
								value={name}
								disabled={saving || !permits.update}
								placeholder="Kitchen supervisor"
								onChange={(event) => setName(event.target.value)}
							/>
						</Field>

						<Field>
							<FieldLabel htmlFor={`role-description-${role.id}`} className="gap-1.5">
								Description
								{descriptionDirty ? <DirtyDot /> : null}
							</FieldLabel>
							<Input
								id={`role-description-${role.id}`}
								value={description}
								disabled={saving || !permits.update}
								placeholder="Runs the pass, minds the printers"
								onChange={(event) => setDescription(event.target.value)}
							/>
						</Field>

						<Field>
							<span className="flex items-center gap-1.5 text-sm leading-none font-medium select-none">
								Permissions
								{permissionsDirty ? <DirtyDot /> : null}
							</span>
							<Button
								type="button"
								variant="outline"
								className="h-9 justify-start font-normal"
								disabled={saving || !permits.update}
								onClick={() => {
									returningFromPermissions.current = true;
									setPermissionsOpen(true);
									setOpen(false);
								}}
							>
								<SlidersHorizontal className="size-3.5" />
								{permissions.length === 0 ? (
									<span className="text-amber-400">No permissions</span>
								) : (
									<span>{permissions.length === 1 ? "1 permission" : `${permissions.length} permissions`}</span>
								)}
								<span className="ml-auto text-[11px] text-subtle-foreground">Change</span>
							</Button>
							<FieldDescription>Every member gets these, the moment you save.</FieldDescription>
						</Field>

						{beyond.length > 0 ? (
							<Alert>
								<AlertDescription>
									You do not hold {beyond.join(", ")} yourself, so this will be refused. Untick{" "}
									{beyond.length === 1 ? "it" : "them"} or ask somebody who holds {beyond.length === 1 ? "it" : "them"}{" "}
									to make this change.
								</AlertDescription>
							</Alert>
						) : null}

						{error ? (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
					</DialogBody>

					{/*
					 * Delete sits in the footer, on the far side from Save. A "Danger zone" heading over one
					 * button is a section made of nothing, and this form is short enough that the button
					 * needs no warning band around it to be seen — the distance from Save is the warning.
					 */}
					<DialogFooter>
						{permits.remove ? (
							<DeleteRoleAction
								disabled={saving}
								memberCount={role.members.length}
								onDeleted={() => setOpen(false)}
								roleId={role.id}
								roleName={role.name}
							/>
						) : null}
						{dirtyCount > 0 ? (
							<span className="mr-auto text-[12.5px] text-muted-foreground">
								{dirtyCount === 1 ? "1 unsaved change" : `${dirtyCount} unsaved changes`}
							</span>
						) : (
							<span className="mr-auto" />
						)}
						<Button type="button" variant="ghost" disabled={saving || dirtyCount === 0} onClick={reset}>
							Discard
						</Button>
						<Button
							type="button"
							disabled={saving || dirtyCount === 0 || !permits.update || name.trim() === ""}
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

/**
 * Deleting, which keeps its confirmation.
 *
 * The one action here that cannot be staged: it destroys the thing being edited, so there is no role
 * left for Save changes to apply the rest of the form to.
 */
function DeleteRoleAction({
	roleId,
	roleName,
	memberCount,
	disabled,
	onDeleted,
}: {
	roleId: string;
	roleName: string;
	memberCount: number;
	disabled: boolean;
	onDeleted: () => void;
}) {
	const [pending, startTransition] = useTransition();

	return (
		<AlertDialog>
			<AlertDialogTrigger
				disabled={disabled || pending}
				render={<Button type="button" variant="ghost" className="text-destructive hover:bg-destructive/10" />}
			>
				<Trash2 className="size-3.5" />
				Delete role
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete {roleName}?</AlertDialogTitle>
					<AlertDialogDescription>
						Its {memberCount === 1 ? "one member" : `${memberCount} members`} lose everything this role carried.
						Whatever they hold individually is untouched.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={() =>
							startTransition(async () => {
								const result = await deleteRole(roleId);
								if (result.error) {
									toast.error(result.error);
									return;
								}
								toast.success(`${roleName} deleted.`);
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
