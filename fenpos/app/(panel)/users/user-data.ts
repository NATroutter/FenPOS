/**
 * The shapes the Users tab passes across the server/client boundary.
 *
 * Their own module because the table, the manage dialog and the create dialog all need them, and a
 * type exported from whichever component happened to define it first is how three components end up
 * importing each other in a ring.
 */

/** An account as the table and the manage dialog need it, serialised for the client boundary. */
export interface UserRowData {
	id: string;
	name: string;
	email: string;
	/** The letter drawn when there is no picture, or the picture failed to load. */
	initial: string;
	/**
	 * Whether the account already has a stored avatar.
	 *
	 * Ids-only plumbing from `usersWithAvatars`, not the picture itself — drawing the picture is
	 * `avatarUrl`'s job below. This much is also enough on its own to word the avatar control's own
	 * copy ("Set" versus "Change").
	 */
	hasAvatar: boolean;
	/**
	 * The stored picture's URL, or null when there is none.
	 *
	 * Points at the authenticated `/api/avatar/[userId]` route rather than embedding bytes here, so a
	 * list of many rows costs one small request per row instead of loading every stored image into
	 * this server render.
	 */
	avatarUrl: string | null;
	isSuperuser: boolean;
	mustChangePassword: boolean;
	banned: boolean;
	banReason: string | null;
	banExpires: string | null;
	twoFactorEnabled: boolean;
	createdAt: string;
	roles: { id: string; name: string }[];
	permissions: string[];
	sessionCount: number;
}

/** A role as the account dialogs list it, with what it carries so the form can lock what it gives. */
export interface GrantableRole {
	id: string;
	name: string;
	permissions: string[];
}

/** Which actions to render. Convenience only — every action checks again on the server. */
export interface UserPermits {
	create: boolean;
	update: boolean;
	setPassword: boolean;
	forceReset: boolean;
	ban: boolean;
	unban: boolean;
	revokeSessions: boolean;
	remove: boolean;
	grant: boolean;
	disableTwoFactor: boolean;
	setSuperuser: boolean;
}
