import "server-only";
import { userHolds } from "@/lib/auth/effective-permissions";
import type { PanelPermission } from "@/lib/domain/panel-permissions";

/**
 * What a page hands its client components so they can leave out what the operator cannot use.
 *
 * **Convenience, never the boundary.** Every action behind these controls is refused again by
 * `panel-action.ts` against the same permission, and that refusal is what actually protects
 * anything — a page that got this wrong would render a button that comes back `DENIED`, not a
 * button that works. What this fixes is the other half: a read-only operator was being shown a
 * screen full of controls that could only ever refuse them, with no way to tell which of them were
 * meant for somebody else.
 *
 * **Hidden rather than disabled.** That is the panel's existing answer — `permittedNavHrefs` leaves
 * whole sections out of the sidebar, and the account, role and key dialogs leave out the controls
 * and the section headings above them — so this follows it rather than introducing a second
 * convention. A disabled control also has to explain itself somewhere, and the only place a tooltip
 * reaches is a mouse.
 */

/**
 * Resolves a page's permissions in one pass.
 *
 * Written as one call over a list rather than a `userHolds` per control so a page cannot end up
 * checking six permissions in six places and forgetting the seventh. The reads are cheap and
 * concurrent, and `effectivePermissions` memoises per request anyway, so a page asking about nine
 * permissions still makes one query.
 *
 * @param user the acting account; a superuser holds everything, which `userHolds` answers without a
 *   row, so a page never has to special-case them
 * @param permissions what this page's controls are gated on
 * @returns one flag per permission, keyed by the permission itself
 */
export async function permitsFor<const K extends PanelPermission>(
	user: { id: string; isSuperuser: boolean },
	permissions: readonly K[],
): Promise<Record<K, boolean>> {
	const held = await Promise.all(permissions.map((permission) => userHolds(user, permission)));
	return Object.fromEntries(permissions.map((permission, index) => [permission, held[index]])) as Record<K, boolean>;
}
