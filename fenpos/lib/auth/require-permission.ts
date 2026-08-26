import "server-only";
import { redirect } from "next/navigation";
import { recordAudit, userActor } from "@/lib/audit/audit-log";
import { requestProvenance } from "@/lib/audit/provenance";
import { PAGE_VIEW_ACTION } from "@/lib/audit/system-actions";
import { userHolds } from "@/lib/auth/effective-permissions";
import { type PanelUser, requireSession } from "@/lib/auth/require-session";
import type { PanelPermission } from "@/lib/domain/panel-permissions";
import { ApiError } from "@/lib/errors";
import { NAV_GROUPS } from "@/lib/navigation";
import { globalAuditSettings } from "@/lib/settings/settings-service";

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
 * Resolves the session, refuses a caller who may not open this page, and records the view.
 *
 * Called at the top of every panel page's server component, **outside** any `try` — both
 * `requireSession` and the redirect below signal by throwing, and a broad catch would turn being
 * signed out or refused into a page that rendered anyway.
 *
 * Refusal goes to `/no-access` rather than to Next's `forbidden()`, which needs an experimental
 * flag this install does not set, and rather than to `/dashboard`, which an account without
 * `dashboard:read` could not open either.
 *
 * **The route is an argument because a server component cannot ask what its own path is.** Next
 * exposes no stable API for it, and deriving it from the permission would be ambiguous — `docs:read`
 * gates three routes. Making it required rather than optional means a page added without naming its
 * route is a compile error rather than a page that quietly records nothing.
 *
 * The view is recorded only when `audit.recordPageViews` is on, and it is **off by default**: a live
 * tab re-renders its server component on every job or log event through `router.refresh()`, so this
 * runs at event rate rather than at navigation rate. Recording is awaited rather than left floating,
 * because a promise a server component does not await can be cut off when the response finishes —
 * and `recordAudit` never throws, so awaiting cannot fail the page.
 *
 * @param permission the permission this page requires
 * @param route the path being opened, as it appears in `lib/navigation.ts`
 * @returns the signed-in user; never null, and never one who lacks the permission
 */
export async function requirePagePermission(permission: PanelPermission, route: string): Promise<PanelUser> {
	const user = await requireSession();

	if (!(await userHolds(user, permission))) {
		redirect("/no-access");
	}

	const { recordPageViews } = await globalAuditSettings();
	if (recordPageViews) {
		await recordAudit({
			action: PAGE_VIEW_ACTION,
			outcome: "SUCCESS",
			actor: userActor(user),
			target: { kind: "page", id: route },
			provenance: await requestProvenance(),
		});
	}

	return user;
}

/**
 * The sidebar sections this account may open, as bare route paths.
 *
 * **Paths rather than the `NavItem`s themselves, and that is the whole point.** Every item carries
 * `icon: LucideIcon`, which is a function component, and the sidebar is a Client Component — handing
 * it a filtered `NavGroup[]` from the server layout meant handing a function across the
 * server-to-client boundary, which React refuses with "Only plain objects can be passed to Client
 * Components". It refuses it fatally: every page under the panel layout rendered "This page couldn't
 * load", which is how this was eventually found. A `string[]` crosses cleanly, and the icons stay
 * where they always were — imported by the sidebar, on the client.
 *
 * The server still decides. The sidebar filters its own copy of `NAV_GROUPS` down to these paths and
 * cannot widen the answer, because a path it was not given is one it does not render.
 *
 * This is convenience either way. {@link requirePagePermission} is the boundary, because anyone can
 * type a URL.
 *
 * Sequential `await` rather than `Promise.all`: `userHolds` reads a per-request memo after the first
 * call, so concurrency would buy nothing and the loop reads as what it is.
 *
 * @param user the signed-in account
 * @returns the `href` of every section and child section this account may open
 */
export async function permittedNavHrefs(user: PanelUser): Promise<string[]> {
	const hrefs: string[] = [];

	for (const group of NAV_GROUPS) {
		for (const item of group.items) {
			if (!(await userHolds(user, item.permission))) {
				continue;
			}
			hrefs.push(item.href);
			for (const child of item.children ?? []) {
				if (await userHolds(user, child.permission)) {
					hrefs.push(child.href);
				}
			}
		}
	}

	return hrefs;
}
