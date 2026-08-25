import "server-only";
import { redirect } from "next/navigation";
import { userHolds } from "@/lib/auth/effective-permissions";
import { type PanelUser, requireSession } from "@/lib/auth/require-session";
import type { PanelPermission } from "@/lib/domain/panel-permissions";
import { ApiError } from "@/lib/errors";

/**
 * The page-side half of authorisation.
 *
 * A page and an action are refused differently, on purpose. A page is a destination somebody
 * navigated to, so being refused means going somewhere that explains it. An action is a POST
 * endpoint, so being refused means an error the form renders in place — {@link
 * PermissionDeniedError}, which `lib/auth/panel-action.ts` raises and every action's existing catch
 * already knows how to display.
 *
 * The sidebar filters itself so a section a user cannot open is never offered. That filter is
 * convenience; this is the boundary. Anyone can type a URL.
 */

/** What every refusal says, whatever was refused. */
export const REFUSAL_MESSAGE = "You do not have permission to do that. Ask an administrator if you need it.";

/**
 * A caller was refused because of what they hold, not because of what they sent.
 *
 * Extends `ApiError` so it travels the path a refusal should: every action helper in this codebase
 * passes an `ApiError`'s message through to the form and logs anything else in full as unexpected.
 * A refusal is entirely expected, and logging it as a fault would bury the ones that are not.
 *
 * Carries `insufficient_permission`, which the public API contract already defines as "the caller
 * is identified but lacks the permission for this action" — the same meaning, reached from the
 * panel rather than from a key. No new code was invented for it.
 *
 * The permission is carried but never shown. It is what the audit row records.
 */
export class PermissionDeniedError extends ApiError {
	/** The permission the caller was missing. */
	readonly permission: PanelPermission;

	/**
	 * @param permission the permission the caller was missing
	 */
	constructor(permission: PanelPermission) {
		super("insufficient_permission", REFUSAL_MESSAGE);
		this.permission = permission;
		this.name = "PermissionDeniedError";
	}
}

/**
 * Resolves the session and refuses a caller who may not open this page.
 *
 * Called at the top of every panel page's server component, **outside** any `try` — both
 * `requireSession` and the redirect below signal by throwing, and a broad catch would turn being
 * signed out or refused into a page that rendered anyway.
 *
 * Refusal goes to `/no-access` rather than to Next's `forbidden()`, which needs an experimental
 * flag this install does not set, and rather than to `/dashboard`, which an account without
 * `dashboard:read` could not open either.
 *
 * @param permission the permission this page requires
 * @returns the signed-in user; never null, and never one who lacks the permission
 */
export async function requirePagePermission(permission: PanelPermission): Promise<PanelUser> {
	const user = await requireSession();

	if (!(await userHolds(user, permission))) {
		redirect("/no-access");
	}

	return user;
}
