"use client";

import { type ReactElement, useState, useTransition } from "react";
import { toast } from "sonner";
import { createUser } from "@/app/(panel)/users/actions";
import type { GrantableRole } from "@/app/(panel)/users/user-data";
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

/**
 * Creates an account.
 *
 * **Nothing is emailed, ever.** Whoever creates the account delivers the credentials themselves, by
 * whatever means they judge appropriate — which is why the password is typed here rather than
 * generated and sent, and why "Require password reset" is offered right beside it: it is the one
 * thing that stops a password typed into a chat window remaining the account's password.
 *
 * Creating only. Everything about an account that already exists — its name, its grants, its
 * password, its sessions — is on one screen in `ManageUserDialog`, reached from its row.
 */
export function UserDialog({
	roles,
	editorHolds,
	trigger,
}: {
	roles: GrantableRole[];
	editorHolds: string[];
	trigger: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [requireReset, setRequireReset] = useState(true);
	const [roleIds, setRoleIds] = useState<string[]>([]);
	const [permissions, setPermissions] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [saving, startSave] = useTransition();

	const toggle = (list: string[], value: string): string[] =>
		list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

	// A role carrying something the editor does not hold cannot be assigned by them, so it is not
	// offered. `grant-service.ts` refuses the same thing again; this is what stops the operator
	// finding that out only after pressing Save.
	const assignable = roles.filter((role) => role.permissions.every((permission) => editorHolds.includes(permission)));

	const reset = (): void => {
		setError(null);
		setName("");
		setEmail("");
		setPassword("");
		setRequireReset(true);
		setRoleIds([]);
		setPermissions([]);
	};

	const save = (): void => {
		setError(null);
		startSave(async () => {
			const result = await createUser({
				name,
				email,
				password,
				requirePasswordReset: requireReset,
				roleIds,
				permissions,
			});
			if (result.error) {
				setError(result.error);
				return;
			}
			toast.success("Account created.");
			setOpen(false);
		});
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) {
					reset();
				}
			}}
			onOpenChangeComplete={(nowOpen) => {
				if (!nowOpen) {
					reset();
				}
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-[560px]">
				<DialogHeader>
					<DialogTitle>New account</DialogTitle>
					<DialogDescription>
						Nothing is emailed. Give this person their password yourself, and require a reset so it stops being the one
						you typed.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="flex flex-col gap-4">
						<Field>
							<FieldLabel htmlFor="user-name">Name</FieldLabel>
							<Input
								id="user-name"
								value={name}
								disabled={saving}
								placeholder="Sam Operator"
								onChange={(event) => setName(event.target.value)}
							/>
						</Field>

						<Field>
							<FieldLabel htmlFor="user-email">Email</FieldLabel>
							<Input
								id="user-email"
								type="email"
								value={email}
								disabled={saving}
								placeholder="sam@example.com"
								onChange={(event) => setEmail(event.target.value)}
							/>
							<FieldDescription>What they sign in with. Nothing is sent to it.</FieldDescription>
						</Field>

						<Field>
							<FieldLabel htmlFor="user-password">Password</FieldLabel>
							<Input
								id="user-password"
								type="password"
								value={password}
								disabled={saving}
								onChange={(event) => setPassword(event.target.value)}
							/>
						</Field>

						<div className="flex items-start gap-2.5">
							<Checkbox
								id="user-require-reset"
								className="mt-0.5"
								checked={requireReset}
								disabled={saving}
								onCheckedChange={() => setRequireReset((current) => !current)}
							/>
							<FieldLabel
								htmlFor="user-require-reset"
								className="w-full cursor-pointer flex-col items-start gap-0.5 font-normal"
							>
								<span className="text-[12.5px]">Require password reset</span>
								<span className="text-[11.5px] text-subtle-foreground">
									They reach nothing but the page that takes a new password until they set one.
								</span>
							</FieldLabel>
						</div>

						<div className="flex flex-col gap-2.5 border-t border-border pt-3">
							<span className="text-[12.5px] font-medium">Roles</span>
							{assignable.length === 0 ? (
								<p className="text-[11.5px] text-subtle-foreground">
									No roles you can assign. Create one on the Roles tab, or grant permissions individually below.
								</p>
							) : (
								assignable.map((role) => (
									<div key={role.id} className="flex items-center gap-2.5">
										<Checkbox
											id={`role-${role.id}`}
											checked={roleIds.includes(role.id)}
											disabled={saving}
											onCheckedChange={() => setRoleIds((current) => toggle(current, role.id))}
										/>
										<FieldLabel htmlFor={`role-${role.id}`} className="cursor-pointer font-normal">
											{role.name}
										</FieldLabel>
									</div>
								))
							)}
						</div>

						<div className="border-t border-border pt-3">
							<PermissionChecklist selected={permissions} locked={[]} disabled={saving} onChange={setPermissions} />
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
					<Button
						type="button"
						disabled={saving || name.trim() === "" || email.trim() === "" || password === ""}
						onClick={save}
					>
						{saving ? <Spinner className="size-3.5" /> : null}
						Create account
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
