import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { isGrantable, type PanelPermission, parseStoredPanelPermissions } from "@/lib/domain/panel-permissions";

/**
 * What an account may actually do.
 *
 * The union of every permission granted to the account directly and every permission carried by a
 * role it belongs to. There is no deny row and no precedence: a permission is held or it is not,
 * which is what lets this be a union rather than a rule two people have to agree on.
 *
 * **A superuser is not resolved through this at all.** {@link userHolds} answers true for them
 * before it looks at any row, because a superuser's authority does not come from grants and must
 * not be removable by deleting them.
 */

/**
 * Reads an account's granted permissions.
 *
 * Memoised through React's `cache`, which scopes the memo to a single request rather than to the
 * process — the distinction is the whole reason it is safe here. One panel render asks twice, once
 * to filter the sidebar and once to gate the page, and without this the second ask repeats a query
 * whose answer cannot have changed in between. A process-wide cache would be a different thing
 * entirely: a grant revoked in one request would keep working in the next until something evicted
 * it, which is exactly the failure database-backed sessions were chosen to avoid.
 *
 * This is the first use of `cache` in this codebase. It is a per-request memo, not a caching layer.
 *
 * @param userId the account to resolve
 * @returns the identifiers this version still recognises, as a set
 */
export const effectivePermissions = cache(async (userId: string): Promise<ReadonlySet<PanelPermission>> => {
	// Two queries rather than one join, because the two answers are unions of each other and a join
	// would return the cross product of roles and permissions for an account holding several of
	// each — more rows than either query alone, to compute a set.
	const [direct, viaRoles] = await Promise.all([
		prisma.userPermission.findMany({ where: { userId }, select: { permission: true } }),
		prisma.rolePermission.findMany({
			where: { role: { members: { some: { userId } } } },
			select: { permission: true },
		}),
	]);

	const stored = [...direct, ...viaRoles].map((row) => row.permission);
	// Two filters, and the second is not redundant. `parseStoredPanelPermissions` drops identifiers
	// this version no longer defines; `isGrantable` drops the ones it defines but that no grant may
	// ever hand out. `grant-guard.ts` refuses to *write* such a row and the account screen renders no
	// checkbox for one, but neither of those reaches a row put there by hand, by a restored backup,
	// or by a version that policed it less carefully — and a row nobody was allowed to create must
	// not be honoured just because it exists. Same reasoning as dropping an unknown identifier:
	// where a grant is in doubt, the safe answer is no.
	return new Set(parseStoredPanelPermissions(stored).filter(isGrantable));
});

/**
 * Whether an account may do one specific thing.
 *
 * @param user the acting account; only the two fields the answer depends on are required, so a
 *   caller holding a full `PanelUser` can pass it directly
 * @param permission what is being attempted
 * @returns true when the account is a superuser, or holds the permission
 */
export async function userHolds(
	user: { id: string; isSuperuser: boolean },
	permission: PanelPermission,
): Promise<boolean> {
	// Checked before any read: a superuser's authority is what they are, not what they hold, and
	// deleting every one of their grant rows must not change this answer.
	if (user.isSuperuser) {
		return true;
	}
	return (await effectivePermissions(user.id)).has(permission);
}
