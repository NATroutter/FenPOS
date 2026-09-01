"use client";

import { type ReactElement, useState, useTransition } from "react";
import { toast } from "sonner";
import { createRole } from "@/app/(panel)/roles/actions";
import { PermissionChecklist } from "@/components/panel/permission-checklist";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

/**
 * Creates a role.
 *
 * Creating only. Everything about a role that already exists — its name, what it gives, who is in
 * it — is on one screen in `ManageRoleDialog`, reached from its row.
 *
 * The permission list is not filtered to what the editor holds. It is the same list for everybody,
 * and a submission naming something beyond the editor's own authority comes back refused with a
 * message that says which — a checklist whose contents differ per viewer is one nobody can compare
 * against a colleague's screen.
 */
export function RoleDialog({ editorHolds, trigger }: { editorHolds: string[]; trigger: ReactElement }) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [permissions, setPermissions] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [saving, startSave] = useTransition();

	const beyond = permissions.filter((permission) => !editorHolds.includes(permission));

	const restore = (): void => {
		setError(null);
		setName("");
		setDescription("");
		setPermissions([]);
	};

	const save = (): void => {
		setError(null);
		startSave(async () => {
			const result = await createRole({ name, description, permissions, memberIds: [] });
			if (result.error) {
				setError(result.error);
				return;
			}
			toast.success("Role created.");
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
					<DialogTitle>New role</DialogTitle>
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

						{/* No member list. Who is in a role is set from the Users tab, on the screen that asks
						    "what does this person hold" — a new role starts empty and is filled from there. */}
						<div className="border-t border-border pt-3">
							<PermissionChecklist selected={permissions} locked={[]} disabled={saving} onChange={setPermissions} />
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
						Create role
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
