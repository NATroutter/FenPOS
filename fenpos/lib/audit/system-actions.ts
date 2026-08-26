/**
 * The audit action ids the server writes on its own behalf.
 *
 * Neither registry entries nor auth events. A retention sweep and a page view are not server actions
 * — nobody submitted a form and there is no permission to check — so `lib/auth/panel-actions.ts` has
 * nothing to say about them, and `AUTH_AUDIT_ACTIONS` is for the events at the edge of
 * authentication, which these are not either.
 *
 * Declared as constants for the same reason `AUTH_AUDIT_ACTIONS` is: these strings are what the
 * `/audit` filter matches on, and a row that says `audit:swept` because somebody typed it that way
 * once is a row no filter finds.
 */

/** A retention sweep, recorded by the sweep itself after it has removed and re-anchored. */
export const AUDIT_SWEEP_ACTION = "audit:sweep";

/** An authenticated panel page was opened. Written only when `audit.recordPageViews` is on. */
export const PAGE_VIEW_ACTION = "page:view";

/** Both of the above, for the filter that has to offer every action a row can carry. */
export const SYSTEM_AUDIT_ACTIONS: readonly string[] = [AUDIT_SWEEP_ACTION, PAGE_VIEW_ACTION];
