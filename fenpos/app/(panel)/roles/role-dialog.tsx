"use client";

import { type ReactElement, useState, useTransition } from "react";
import { toast } from "sonner";
import { createRole, updateRole } from "@/app/(panel)/roles/actions";
import { PermissionChecklist } from "@/components/panel/permission-checklist";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { PanelPermission } from "@/lib/domain/panel-permissions";

/** An account this dialog can put in a role. */
export interface RoleCandidate {
	id: string;
	name: string;
	email: string;
}

/**
 * Creates a role, or edits one.
 *
 * Everything is replaced wholesale rather than merged, so the form is the whole truth about the
 * role — a merge would make removing a permission impossible from the screen that added it.
 *
 * The permission list is not filtered to what the editor holds. It is the same list for everybody,
 * and a submission naming something beyond the editor's own authority comes back refused with a
 * message that says which — a checklist whose contents differ per viewer is one nobody can compare
 * against a colleague's screen.
 */
export function RoleDialog({
	candidates,
	editorHolds,
	roleId,
	initialName,
	initialDescription,
	initialPermissions,
	initialMemberIds,
	trigger,
}: {
	candidates: RoleCandidate[];
	editorHolds: string[];
	roleId?: string;
	initialName?: string;
	initialDescription?: string;
	initialPermissions?: string[];
	initialMemberIds?: string[];
	trigger: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState(initialName ?? "");
	const [description, setDescription] = useState(initialDescription ?? "");
	const [permissions, setPermissions] = useState<string[]>(initialPermissions ?? []);
	const [memberIds, setMemberIds] = useState<string[]>(initialMemberIds ?? []);
	const [error, setError] = useState<string | null>(null);
	const [saving, startSave] = useTransition();

	const toggle = (list: string[], value: string): string[] =>
		list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

	const beyond = permissions.filter((permission) => !editorHolds.includes(permission));

	const restore = (): void => {
		setError(null);
		setName(initialName ?? "");
		setDescription(initialDescription ?? "");
		setPermissions(initialPermissions ?? []);
		setMemberIds(initialMemberIds ?? []);
	};

	const save = (): void => {
		setError(null);
		startSave(async () => {
			const input = { name, description, permissions, memberIds };
			const result = roleId ? await updateRole(roleId, input) : await createRole(input);
			if (result.error) {
				setError(result.error);
				return;
			}
			toast.success(roleId ? "Role updated." : "Role created.");
			setOpen(false);
		});
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) {
					restore();
				}
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-[560px]">
				<DialogHeader>
					<DialogTitle>{roleId ? "Edit role" : "New role"}</DialogTitle>
					<DialogDescription>
						Saving changes what every member can do, immediately. That is what a role is for.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="flex flex-col gap-4">
						<Field>
							<FieldLabel htmlFor="role-name">Name</FieldLabel>
							<Input
								id="role-name"
								value={name}
								disabled={saving}
								placeholder="Kitchen supervisor"
								onChange={(event) => setName(event.target.value)}
							/>
						</Field>

						<Field>
							<FieldLabel htmlFor="role-description">Description</FieldLabel>
							<Input
								id="role-description"
								value={description}
								disabled={saving}
								placeholder="Runs the pass, minds the printers"
								onChange={(event) => setDescription(event.target.value)}
							/>
							<FieldDescription>Optional. One line on who this role is for.</FieldDescription>
						</Field>

						<div className="flex flex-col gap-2.5 border-t border-border pt-3">
							<span className="text-[12.5px] font-medium">Members</span>
							{candidates.length === 0 ? (
								<p className="text-[11.5px] text-subtle-foreground">No accounts yet.</p>
							) : (
								candidates.map((candidate) => (
									<div key={candidate.id} className="flex items-center gap-2.5">
										<Checkbox
											id={`member-${candidate.id}`}
											checked={memberIds.includes(candidate.id)}
											disabled={saving}
											onCheckedChange={() => setMemberIds((current) => toggle(current, candidate.id))}
										/>
										<FieldLabel htmlFor={`member-${candidate.id}`} className="cursor-pointer font-normal">
											{candidate.name}
											<span className="ml-2 text-[11px] text-subtle-foreground">{candidate.email}</span>
										</FieldLabel>
									</div>
								))
							)}
						</div>

						<div className="border-t border-border pt-3">
							<PermissionChecklist
								selected={permissions}
								locked={[]}
								disabled={saving}
								onToggle={(permission: PanelPermission) => setPermissions((current) => toggle(current, permission))}
							/>
						</div>

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
					</div>
				</DialogBody>
				<DialogFooter>
					<Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button type="button" disabled={saving || name.trim() === ""} onClick={save}>
						{saving ? <Spinner className="size-3.5" /> : null}
						{roleId ? "Save" : "Create role"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
