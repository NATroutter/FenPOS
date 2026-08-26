import { Plus, Shield } from "lucide-react";
import { RoleDialog } from "@/app/(panel)/roles/role-dialog";
import { RoleRow, type RoleRowData } from "@/app/(panel)/roles/role-row";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { listAccounts } from "@/lib/auth/account-service";
import { effectivePermissions } from "@/lib/auth/effective-permissions";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { listRoles } from "@/lib/auth/role-service";
import { isGrantable, PANEL_PERMISSION_IDS, type PanelPermission } from "@/lib/domain/panel-permissions";

export const metadata = { title: "Roles" };

/** Never cached: membership moves from the Users tab as well as from this one. */
export const dynamic = "force-dynamic";

/**
 * The Roles tab.
 *
 * A role is worth having for one reason: editing it changes every member immediately, so revoking a
 * capability across a whole shift is one edit rather than one per person. Everything on this page
 * follows from that — membership is edited here as well as on the Users tab, because "who is in this
 * role" and "what does this person hold" are the same fact asked from two directions.
 */
export default async function RolesPage() {
	// Outside any try: both an absent session and a refusal signal by throwing.
	const user = await requirePagePermission("roles:read", "/roles");

	const [roles, accounts] = await Promise.all([listRoles(), listAccounts()]);

	const held: PanelPermission[] = user.isSuperuser
		? PANEL_PERMISSION_IDS.filter(isGrantable)
		: [...(await effectivePermissions(user.id))];

	const holds = (permission: PanelPermission): boolean => user.isSuperuser || held.includes(permission);

	const permits = {
		create: holds("roles:create"),
		update: holds("roles:update"),
		remove: holds("roles:delete"),
	};

	const rows: RoleRowData[] = roles.map((role) => ({
		id: role.id,
		name: role.name,
		description: role.description,
		permissions: role.permissions,
		members: role.members,
	}));

	const candidates = accounts.map((account) => ({ id: account.id, name: account.name, email: account.email }));

	return (
		<div className="flex flex-col gap-5">
			<div className="flex justify-end">
				{permits.create ? (
					<RoleDialog
						candidates={candidates}
						editorHolds={held}
						trigger={
							<Button>
								<Plus className="size-3.5" />
								New role
							</Button>
						}
					/>
				) : null}
			</div>

			{rows.length === 0 ? (
				<Empty className="border border-dashed border-border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Shield />
						</EmptyMedia>
						<EmptyTitle>No roles yet</EmptyTitle>
						<EmptyDescription>
							A role is a bundle of permissions several people share. Editing one changes what every member can do,
							immediately — which is the point of having them.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<div className="flex flex-col gap-4">
					{rows.map((role) => (
						<RoleRow key={role.id} role={role} candidates={candidates} editorHolds={held} permits={permits} />
					))}
				</div>
			)}
		</div>
	);
}
