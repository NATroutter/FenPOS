"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { ManageRoleDialog } from "@/app/(panel)/roles/manage-role-dialog";
import type { RolePermits, RoleRowData } from "@/app/(panel)/roles/role-data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Every role as one row, with a single Manage button per row.
 *
 * The same table the Users tab uses, for the same reason: each role was a card the height of a
 * paragraph listing every permission it carries as its own pill, so four roles filled a screen and
 * the two controls at the bottom of each were unlabelled glyphs. A row says what a role is and how
 * much it carries; the detail is one click away.
 *
 * No filter chips. Roles have no categories to filter by — the search is over the three things a row
 * shows, which on a list this size is the whole of what filtering could do.
 */
export function RolesTable({
	roles,
	editorHolds,
	permits,
}: {
	roles: RoleRowData[];
	editorHolds: string[];
	permits: RolePermits;
}) {
	const [query, setQuery] = useState("");

	const shown = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (needle === "") {
			return roles;
		}
		return roles.filter(
			(role) =>
				role.name.toLowerCase().includes(needle) ||
				(role.description ?? "").toLowerCase().includes(needle) ||
				// Searched too: "which role carries devices:delete" is a question this list is opened with
				// as often as "where is the kitchen role".
				role.permissions.some((permission) => permission.toLowerCase().includes(needle)) ||
				role.members.some((member) => member.name.toLowerCase().includes(needle)),
		);
	}, [roles, query]);

	return (
		<div className="flex flex-col gap-3">
			<div className="relative">
				<Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-subtle-foreground" />
				<Input
					value={query}
					placeholder="Search by name, description, permission or member"
					className="pl-8"
					onChange={(event) => setQuery(event.target.value)}
				/>
			</div>

			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Role</TableHead>
						<TableHead>Description</TableHead>
						<TableHead className="text-right">Permissions</TableHead>
						<TableHead className="text-right">Members</TableHead>
						<TableHead className="w-[96px]" />
					</TableRow>
				</TableHeader>
				<TableBody>
					{shown.length === 0 ? (
						<TableRow>
							<TableCell colSpan={5} className="py-8 text-center text-[12px] text-subtle-foreground">
								No roles match.
							</TableCell>
						</TableRow>
					) : (
						shown.map((role) => {
							// A role carrying something the editor does not hold is not theirs to edit or delete —
							// the service refuses both. The button still opens, so they can read what it holds; the
							// dialog's own Save is what is closed to them.
							const mine = role.permissions.every((permission) => editorHolds.includes(permission));

							return (
								<TableRow key={role.id}>
									<TableCell className="font-medium">{role.name}</TableCell>
									<TableCell className="max-w-[280px] truncate text-subtle-foreground">
										{role.description ?? "—"}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										<PermissionsCell count={role.permissions.length} />
									</TableCell>
									<TableCell className="text-right tabular-nums">{role.members.length}</TableCell>
									<TableCell className="text-right">
										<ManageRoleDialog
											editorHolds={editorHolds}
											permits={{ ...permits, update: permits.update && mine, remove: permits.remove && mine }}
											role={role}
											trigger={
												<Button variant="outline" size="sm">
													Manage
												</Button>
											}
										/>
									</TableCell>
								</TableRow>
							);
						})
					)}
				</TableBody>
			</Table>
		</div>
	);
}

/**
 * How many permissions a role carries.
 *
 * An empty role is called out in words rather than shown as a plain zero. It is the correct state
 * for one just created, and also what a role somebody emptied by accident looks like — only a person
 * can tell which, and a role that carries nothing while people are assigned to it is a quiet way for
 * access to go missing.
 */
function PermissionsCell({ count }: { count: number }) {
	if (count === 0) {
		return <span className="text-amber-400">None</span>;
	}
	return <span>{count}</span>;
}
