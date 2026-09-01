/**
 * The shapes the Roles tab passes across the server/client boundary.
 *
 * Their own module for the reason `users/user-data.ts` has one: the table, the manage dialog and the
 * create dialog all need them, and a type exported from whichever component defined it first is how
 * three components end up importing each other in a ring.
 */

/** A role as the table and the manage dialog need it. */
export interface RoleRowData {
	id: string;
	name: string;
	description: string | null;
	permissions: string[];
	members: { id: string; name: string }[];
}

/** An account a role can be given to. */
export interface RoleCandidate {
	id: string;
	name: string;
	email: string;
}

/** Which actions to render. Convenience only — every action checks again on the server. */
export interface RolePermits {
	create: boolean;
	update: boolean;
	remove: boolean;
}
