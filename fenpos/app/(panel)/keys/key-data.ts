/**
 * The shapes the Keys tab passes across the server/client boundary.
 *
 * Their own module for the reason `users/user-data.ts` is: the table, the manage dialog and the
 * create dialog all need them, and a type exported from whichever component happened to define it
 * first is how three components end up importing each other in a ring.
 */

/** A key as the table and the manage dialog need it, serialised for the client boundary. */
export interface KeyRowData {
	id: string;
	name: string;
	/** The last few characters of the secret. All that is ever shown of it after minting. */
	maskedHint: string;
	createdAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
	permissions: string[];
	devices: { id: string; name: string; agentName: string }[];
	/** Who minted it, or null for a key that predates the column. */
	createdByName: string | null;
	/** This key's webhook subscription, or null when it has none. */
	webhook: { url: string } | null;
}

/** A printer a key can be granted, as the dialogs list it. */
export interface GrantableDevice {
	id: string;
	name: string;
	agentName: string;
}

/** Which actions to render. Convenience only — every action checks again on the server. */
export interface KeyPermits {
	create: boolean;
	update: boolean;
	rename: boolean;
	reroll: boolean;
	revoke: boolean;
	remove: boolean;
	setWebhook: boolean;
	removeWebhook: boolean;
}
