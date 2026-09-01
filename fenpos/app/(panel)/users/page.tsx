import { UserPlus } from "lucide-react";
import type { UserRowData } from "@/app/(panel)/users/user-data";
import { UserDialog } from "@/app/(panel)/users/user-dialog";
import { UsersTable } from "@/app/(panel)/users/users-table";
import { Button } from "@/components/ui/button";
import { listAccounts } from "@/lib/auth/account-service";
import { avatarInitial } from "@/lib/auth/avatar";
import { usersWithAvatars } from "@/lib/auth/avatar-service";
import { effectivePermissions } from "@/lib/auth/effective-permissions";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { listRoles } from "@/lib/auth/role-service";
import { isGrantable, PANEL_PERMISSION_IDS, type PanelPermission } from "@/lib/domain/panel-permissions";

export const metadata = { title: "Users" };

/** Never cached: session counts and ban expiries move without any request to this page causing it. */
export const dynamic = "force-dynamic";

/**
 * The Users tab.
 *
 * An account is inert until somebody grants it something, which is the only safe default for a
 * credential created before anyone has decided what it is for — the same rule a new API key follows.
 *
 * What this page hands the client is deliberately more than the accounts: it also hands down what
 * the *acting* account may grant, because a client component cannot read the database and "may I
 * change this checkbox" is a database question. That filtering is convenience. `grant-service.ts`
 * refuses the same things again on the way in, and that is the boundary.
 */
export default async function UsersPage() {
	// Outside any try: both an absent session and a refusal signal by throwing.
	const user = await requirePagePermission("users:read", "/users");

	const [accounts, roles] = await Promise.all([listAccounts(), listRoles()]);

	// Ids only, not the bytes: this page draws one row per account and needs to know whether to point
	// an avatar control at "set" or "replace" copy, not to read every stored picture into memory to
	// render a list that shows none of them at full size. Each row's `avatarUrl` below points at the
	// authenticated route that re-reads the stored bytes itself, per request.
	const withAvatars = await usersWithAvatars(accounts.map((account) => account.id));

	// A superuser holds everything grantable without a row saying so, which is exactly what
	// `effectivePermissions` cannot tell you — it reads rows. Resolved here rather than inside the
	// dialogs, which have no database to ask.
	const held: PanelPermission[] = user.isSuperuser
		? PANEL_PERMISSION_IDS.filter(isGrantable)
		: [...(await effectivePermissions(user.id))];

	const holds = (permission: PanelPermission): boolean => user.isSuperuser || held.includes(permission);

	const permits = {
		create: holds("users:create"),
		update: holds("users:update"),
		setPassword: holds("users:set-password"),
		forceReset: holds("users:force-reset"),
		ban: holds("users:ban"),
		unban: holds("users:unban"),
		revokeSessions: holds("users:revoke-sessions"),
		remove: holds("users:delete"),
		grant: holds("users:grant"),
		disableTwoFactor: holds("users:disable-2fa"),
		// Never held through a grant row, so this is "is a superuser" written the long way.
		setSuperuser: user.isSuperuser,
	};

	const rows: UserRowData[] = accounts.map((account) => {
		const avatarUpdatedAt = withAvatars.get(account.id);

		return {
			id: account.id,
			name: account.name,
			email: account.email,
			initial: avatarInitial(account.name),
			hasAvatar: avatarUpdatedAt !== undefined,
			// `?v=` is the row's own `updatedAt`, and it is what makes a replaced picture appear. Without
			// it every `<img>` points at a string that never changes, so React keeps the same element and
			// the browser never revalidates — an administrator who re-cropped somebody's avatar saw the
			// old face until they reloaded the page by hand.
			avatarUrl: avatarUpdatedAt ? `/api/avatar/${account.id}?v=${avatarUpdatedAt.getTime()}` : null,
			isSuperuser: account.isSuperuser,
			mustChangePassword: account.mustChangePassword,
			banned: account.banned,
			banReason: account.banReason,
			banExpires: account.banExpires?.toISOString() ?? null,
			twoFactorEnabled: account.twoFactorEnabled,
			createdAt: account.createdAt.toISOString(),
			roles: account.roles,
			permissions: account.permissions,
			sessionCount: account.sessionCount,
		};
	});

	const grantableRoles = roles.map((role) => ({
		id: role.id,
		name: role.name,
		permissions: role.permissions as string[],
	}));

	return (
		<div className="flex flex-col gap-5">
			<div className="flex justify-end">
				{permits.create ? (
					<UserDialog
						roles={grantableRoles}
						editorHolds={held}
						trigger={
							<Button>
								<UserPlus className="size-3.5" />
								New account
							</Button>
						}
					/>
				) : null}
			</div>

			<UsersTable accounts={rows} roles={grantableRoles} editorHolds={held} actingUserId={user.id} permits={permits} />
		</div>
	);
}
