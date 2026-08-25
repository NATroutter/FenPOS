"use client";

import { Settings2, Shield, Trash2 } from "lucide-react";
import type { ReactElement } from "react";
import { useTransition } from "react";
import { toast } from "sonner";
import { deleteRole } from "@/app/(panel)/roles/actions";
import { type RoleCandidate, RoleDialog } from "@/app/(panel)/roles/role-dialog";
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

/** A role as this component needs it, serialised for the client boundary. */
export interface RoleRowData {
	id: string;
	name: string;
	description: string | null;
	permissions: string[];
	members: { id: string; name: string }[];
}

/** Which row actions to render. Convenience only — every action checks again. */
export interface RolePermits {
	create: boolean;
	update: boolean;
	remove: boolean;
}

/**
 * One role: what it carries, who is in it, and how to change either.
 *
 * A role carrying nothing is called out. It is the correct state for one just created, and also what
 * a role somebody emptied by accident looks like; only the operator can tell which, and a role that
 * silently confers nothing while people are assigned to it is a quiet way for access to go missing.
 */
export function RoleRow({
	role,
	candidates,
	editorHolds,
	permits,
}: {
	role: RoleRowData;
	candidates: RoleCandidate[];
	editorHolds: string[];
	permits: RolePermits;
}) {
	const [pending, startTransition] = useTransition();

	// A role carrying something the editor does not hold is not theirs to edit or delete — the
	// service refuses both. Not offering the buttons saves them finding that out after pressing one.
	const mine = role.permissions.every((permission) => editorHolds.includes(permission));

	const remove = (): void => {
		startTransition(async () => {
			const result = await deleteRole(role.id);
			if (result.error) {
				toast.error(result.error);
			} else {
				toast.success(`${role.name} deleted.`);
			}
		});
	};

	return (
		<Card>
			<CardHeader className="flex flex-row flex-wrap items-center gap-3 border-b border-border pb-3">
				<Shield className="size-4.5 shrink-0 text-subtle-foreground" />
				<div className="min-w-0 flex-1">
					<div className="truncate text-[13.5px] font-medium">{role.name}</div>
					{role.description ? (
						<div className="mt-0.5 truncate text-[11.5px] text-subtle-foreground">{role.description}</div>
					) : null}
				</div>
				<Badge variant="outline" className="border-border">
					{role.members.length === 1 ? "1 member" : `${role.members.length} members`}
				</Badge>
			</CardHeader>

			<CardContent className="flex flex-col gap-4 pt-4">
				<div className="min-w-0">
					<div className="text-[11px] font-medium text-subtle-foreground">Permissions</div>
					{role.permissions.length === 0 ? (
						<p className="mt-1 text-[11.5px] text-amber-400">None — this role confers nothing.</p>
					) : (
						<div className="mt-1.5 flex flex-wrap gap-1.5">
							{role.permissions.map((permission) => (
								<Badge key={permission} variant="outline" className="font-mono text-[11px]">
									{permission}
								</Badge>
							))}
						</div>
					)}
				</div>

				<CardActions>
					<span className="truncate text-[11.5px] text-subtle-foreground">
						{role.members.length === 0
							? "Nobody is in this role."
							: role.members.map((member) => member.name).join(", ")}
					</span>

					<div className="flex-1" />

					{permits.update && mine ? (
						<RoleDialog
							candidates={candidates}
							editorHolds={editorHolds}
							roleId={role.id}
							initialName={role.name}
							initialDescription={role.description ?? ""}
							initialPermissions={role.permissions}
							initialMemberIds={role.members.map((member) => member.id)}
							trigger={<IconButton title="Edit role" icon={<Settings2 className="size-3.5" />} />}
						/>
					) : null}

					{permits.remove && mine ? (
						<AlertDialog>
							<AlertDialogTrigger
								disabled={pending}
								render={<IconButton title="Delete role" destructive icon={<Trash2 className="size-3.5" />} />}
							/>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>Delete {role.name}?</AlertDialogTitle>
									<AlertDialogDescription>
										Its {role.members.length === 1 ? "one member" : `${role.members.length} members`} lose everything
										this role carried. Whatever they hold individually is untouched.
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>Cancel</AlertDialogCancel>
									<AlertDialogAction onClick={remove}>Delete</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					) : null}
				</CardActions>
			</CardContent>
		</Card>
	);
}

/**
 * One square action button, labelled for a pointer and for a screen reader alike.
 *
 * **Everything else is spread onto the `Button`, and that is load-bearing.** Both `DialogTrigger`
 * and `AlertDialogTrigger` take this element through their `render` prop and clone it with the
 * handlers and ARIA state that make a trigger work. A wrapper that read only its own three props
 * would drop all of that on the floor, leaving a button that renders, looks right, and does nothing.
 */
function IconButton({
	title,
	icon,
	destructive = false,
	...rest
}: React.ComponentProps<typeof Button> & {
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
