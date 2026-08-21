/**
 * Rules about the administrator's profile that both sides of the wire need.
 *
 * Deliberately a plain module: no `server-only`, no `node:` imports, nothing that reaches the
 * database. The action enforces this bound and the field in the dialog hints at it, so it has to
 * be importable from a client component — and it cannot live in `actions.ts`, because a
 * "use server" file may only export async functions.
 */

/** Longest display name accepted. Long enough for a person or a shop, short enough for the footer. */
export const MAXIMUM_DISPLAY_NAME_LENGTH = 60;
