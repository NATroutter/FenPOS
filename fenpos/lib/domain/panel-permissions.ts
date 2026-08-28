import { z } from "zod";

/**
 * The closed set of permissions a panel user may be granted.
 *
 * Separate from `lib/domain/permissions.ts`, which is the API-key set, and deliberately so: a
 * machine client has no business being offered `users:create`, and one merged list is how it would
 * end up being. The two files share a shape and no data.
 *
 * Grants are stored one row per permission — in `user_permissions` for an individual grant, in
 * `role_permissions` for one carried by a role — so a user with no rows and no roles can do
 * nothing. That default is the point: an account created but not yet configured must be inert,
 * never permissive. A superuser bypasses the whole mechanism, which is why promoting one is not
 * itself a grant; see {@link NEVER_GRANTABLE}.
 */

/** One permission and the sentence shown beside its checkbox. */
export interface PanelPermissionDefinition {
	/** Stable identifier persisted in the database and checked at every panel action. */
	readonly id: PanelPermission;
	/** Human-readable explanation for the account-management screen. Not part of any contract. */
	readonly description: string;
}

/** A labelled block of permissions, in the order the account screen renders them. */
export interface PanelPermissionGroup {
	readonly label: string;
	readonly permissions: readonly PanelPermissionDefinition[];
}

/**
 * Permission identifiers.
 *
 * Declared as a tuple so the type, the Zod schema, and the account screen's checkbox list all
 * derive from one declaration and cannot fall out of step — the pattern
 * `lib/domain/permissions.ts` already uses.
 *
 * **The set is complete, including permissions nothing checks yet.** `users:*`, `roles:*`,
 * `audit:*` and `docs:read` gate surfaces that arrive in later phases. They are declared now for
 * the same reason `ActorKind` declared `CLI` before anything wrote one: these strings are a stored
 * contract, and adding a member after grants exist is a migration-shaped decision rather than an
 * edit to a list.
 */
export const PANEL_PERMISSION_IDS = [
	"dashboard:read",

	"agents:read",
	"agents:create",
	"agents:rename",
	"agents:pairing-code",
	"agents:unpair",
	"agents:delete",
	"agents:test-print",

	"devices:read",
	"devices:create",
	"devices:update",
	"devices:delete",
	"devices:pause",
	"devices:connect",
	"devices:clear-queue",
	"devices:test-page",
	"devices:override",
	"devices:scan-ports",

	"jobs:read",
	"jobs:cancel",

	"logs:read",

	"tools:read",
	"tools:preview",
	"tools:print",
	"tools:raw",

	"assets:read",
	"assets:upload",
	"assets:import",
	"assets:rename",
	"assets:replace",
	"assets:delete",

	"variables:read",
	"variables:create",
	"variables:update",
	"variables:delete",
	"variables:preview",

	"keys:read",
	"keys:create",
	"keys:update",
	"keys:rename",
	"keys:reroll",
	"keys:revoke",
	"keys:delete",
	"keys:webhook-set",
	"keys:webhook-remove",

	"users:read",
	"users:create",
	"users:update",
	"users:set-password",
	"users:force-reset",
	"users:ban",
	"users:unban",
	"users:revoke-sessions",
	"users:delete",
	"users:grant",
	"users:disable-2fa",
	"users:set-superuser",

	"roles:read",
	"roles:create",
	"roles:update",
	"roles:delete",

	"audit:read",
	"audit:verify",
	"audit:export",
	"audit:archive-delete",

	"settings:read",
	"settings:write:general",
	"settings:write:limits",
	"settings:write:jobs",
	"settings:write:logs",
	"settings:write:media",
	"settings:write:variables",
	"settings:write:security",
	"settings:write:audit",
	"settings:write:connections",
	"settings:write:panel",

	"docs:read",
] as const;

export type PanelPermission = (typeof PANEL_PERMISSION_IDS)[number];

/** Validates an identifier arriving from a form or a database row. */
export const panelPermissionSchema = z.enum(PANEL_PERMISSION_IDS);

/**
 * Permissions that exist but can never be conferred by a grant.
 *
 * `users:set-superuser` is outside the permission system rather than the top of it: only a
 * superuser may promote or demote one, and no role and no individual grant can hand it over. It is
 * still an identifier because the audit record names the action, and an action needs a name.
 *
 * The account-management screen must not render a checkbox for anything in here.
 */
export const NEVER_GRANTABLE: readonly PanelPermission[] = ["users:set-superuser"];

/**
 * The permissions in the order the account-management screen lists them.
 *
 * Grouped by the section they govern rather than by verb, because that is how somebody deciding
 * what a colleague may do thinks about it: "can they touch the printers" is one question, and
 * "may they delete things" is not a question anybody actually asks.
 */
export const PANEL_PERMISSION_GROUPS: readonly PanelPermissionGroup[] = [
	{
		label: "Dashboard",
		permissions: [{ id: "dashboard:read", description: "See the Dashboard and what it summarises." }],
	},
	{
		label: "Agents",
		permissions: [
			{ id: "agents:read", description: "See the Agents page and each agent's pairing state." },
			{ id: "agents:create", description: "Add an agent and issue its first pairing code." },
			{ id: "agents:rename", description: "Change an agent's name." },
			{ id: "agents:pairing-code", description: "Issue a fresh pairing code for an unpaired agent." },
			{ id: "agents:unpair", description: "Revoke an agent's credential and disconnect it." },
			{ id: "agents:delete", description: "Delete an agent and every printer configured behind it." },
			{
				id: "agents:test-print",
				description: "Send a test job through the server's own compile-and-dispatch path.",
			},
		],
	},
	{
		label: "Devices",
		permissions: [
			{ id: "devices:read", description: "See the Devices page and each printer's configuration." },
			{ id: "devices:create", description: "Add a printer to an agent." },
			{ id: "devices:update", description: "Change a printer's name, port, width or codepage." },
			{ id: "devices:delete", description: "Delete a printer and its queue." },
			{ id: "devices:pause", description: "Pause and resume a printer's queue." },
			{ id: "devices:connect", description: "Connect and disconnect a printer at its agent." },
			{ id: "devices:clear-queue", description: "Discard everything queued for a printer." },
			{ id: "devices:test-page", description: "Print the agent-composed diagnostic page." },
			{ id: "devices:override", description: "Override the install's print limits for one printer." },
			{ id: "devices:scan-ports", description: "Ask an agent which ports it can see." },
		],
	},
	{
		label: "Jobs",
		permissions: [
			{ id: "jobs:read", description: "See the Jobs page and what became of each job." },
			{ id: "jobs:cancel", description: "Cancel a queued job that has not started printing." },
		],
	},
	{
		label: "Logs",
		permissions: [{ id: "logs:read", description: "See the Logs page and what the agents forwarded." }],
	},
	{
		label: "Tools",
		permissions: [
			{
				id: "tools:read",
				description: "Open the Tools page and list the images and variables markup can name.",
			},
			{ id: "tools:preview", description: "Compile markup and see where it lands on the paper, without printing." },
			{ id: "tools:print", description: "Print composed markup to a real printer." },
			{
				id: "tools:raw",
				description:
					"Send raw ESC/POS bytes straight to a printer, bypassing every content check. Also requires the install's 'Allow raw API writes' setting.",
			},
		],
	},
	{
		label: "Assets",
		permissions: [
			{ id: "assets:read", description: "See the Assets page and the images receipts can print." },
			{ id: "assets:upload", description: "Upload an image from this machine." },
			{ id: "assets:import", description: "Fetch an image from a URL." },
			{ id: "assets:rename", description: "Change the name markup refers to an image by." },
			{ id: "assets:replace", description: "Replace an image's bytes, keeping its name." },
			{ id: "assets:delete", description: "Remove an image. Receipts naming it stop compiling." },
		],
	},
	{
		label: "Variables",
		permissions: [
			{ id: "variables:read", description: "See the Variables page and what each name resolves to." },
			{ id: "variables:create", description: "Add a variable." },
			{ id: "variables:update", description: "Change a variable, including its per-printer overrides." },
			{ id: "variables:delete", description: "Remove a variable. Receipts naming it stop compiling." },
			{ id: "variables:preview", description: "Render a date pattern against the current instant while editing." },
		],
	},
	{
		label: "API keys",
		permissions: [
			{ id: "keys:read", description: "See the Keys page: names, masked hints, grants and last use." },
			{ id: "keys:create", description: "Mint a key. The secret is shown once and never again." },
			{ id: "keys:update", description: "Change a key's permissions and the printers it may reach." },
			{ id: "keys:rename", description: "Change a key's name." },
			{ id: "keys:reroll", description: "Replace a key's secret, invalidating the old one immediately." },
			{ id: "keys:revoke", description: "Revoke a key without deleting its record." },
			{ id: "keys:delete", description: "Delete a key's record entirely." },
			{ id: "keys:webhook-set", description: "Point a key's job notifications at a URL." },
			{ id: "keys:webhook-remove", description: "Stop a key's job notifications." },
		],
	},
	{
		label: "Users",
		permissions: [
			{ id: "users:read", description: "See the Users page and each account's sessions." },
			{ id: "users:create", description: "Create an account." },
			{ id: "users:update", description: "Change another account's name or email." },
			{ id: "users:set-password", description: "Set another account's password directly." },
			{
				id: "users:force-reset",
				description: "Require another account to replace its password at next sign-in.",
			},
			{ id: "users:ban", description: "Ban an account, with a reason and an optional expiry." },
			{ id: "users:unban", description: "Lift a ban." },
			{ id: "users:revoke-sessions", description: "End another account's sessions, one or all." },
			{ id: "users:delete", description: "Delete an account. Its audit trail survives it." },
			{
				id: "users:grant",
				description: "Assign roles and individual permissions — never more than you hold yourself.",
			},
			{ id: "users:disable-2fa", description: "Clear another account's two-factor enrolment." },
			{
				id: "users:set-superuser",
				description: "Promote or demote a superuser. Held only by superusers and never grantable.",
			},
		],
	},
	{
		label: "Roles",
		permissions: [
			{ id: "roles:read", description: "See the roles and which permissions each carries." },
			{ id: "roles:create", description: "Create a role." },
			{ id: "roles:update", description: "Change a role's name, description, permissions or membership." },
			{ id: "roles:delete", description: "Delete a role. Its members keep their individual grants." },
		],
	},
	{
		label: "Audit",
		permissions: [
			{ id: "audit:read", description: "See the audit record: who did what, and what came of it." },
			{ id: "audit:verify", description: "Run chain verification from the panel." },
			{ id: "audit:export", description: "Export a filtered range of the audit record." },
			{
				id: "audit:archive-delete",
				description: "Delete an archived audit period for good. Held apart from reading it: this destroys evidence.",
			},
		],
	},
	{
		label: "Settings",
		permissions: [
			{ id: "settings:read", description: "See the Settings page." },
			{ id: "settings:write:general", description: "Change how this install identifies itself." },
			{ id: "settings:write:limits", description: "Change the print limits applied to every request." },
			{
				id: "settings:write:jobs",
				description: "Change how much job history is kept and how a shutdown waits.",
			},
			{ id: "settings:write:logs", description: "Change how much output is written and kept." },
			{ id: "settings:write:media", description: "Change upload limits and what images a job may fetch." },
			{
				id: "settings:write:variables",
				description: "Change what a variable may resolve to, and how much of it one receipt may ask for.",
			},
			{
				id: "settings:write:security",
				description: "Change sessions, sign-in throttling, pairing, and whether raw writes are allowed at all.",
			},
			{
				id: "settings:write:audit",
				description: "Change how much of the audit record is kept, and how much of it is written.",
			},
			{
				id: "settings:write:connections",
				description: "Change the timeouts on the links to agents and to this panel.",
			},
			{ id: "settings:write:panel", description: "Change how this interface displays things." },
		],
	},
	{
		label: "Documentation",
		permissions: [{ id: "docs:read", description: "Read the API and markup documentation served by this install." }],
	},
];

/**
 * Whether a permission can be conferred by any grant at all.
 *
 * @param permission the identifier to test
 * @returns false for anything in {@link NEVER_GRANTABLE}
 */
export function isGrantable(permission: PanelPermission): boolean {
	return !NEVER_GRANTABLE.includes(permission);
}

/**
 * The checkbox list the account and role screens render.
 *
 * Derived from {@link PANEL_PERMISSION_GROUPS} rather than written out a second time, which is what
 * makes "no checkbox for a permission no grant can confer" a property of the data instead of a rule
 * a form has to remember. A group left with nothing in it is dropped: a heading over an empty list
 * is worse than no heading.
 *
 * @returns the groups to render, in the declared order, without the ungrantable
 */
export function grantablePermissionGroups(): PanelPermissionGroup[] {
	return PANEL_PERMISSION_GROUPS.map((group) => ({
		label: group.label,
		permissions: group.permissions.filter((entry) => isGrantable(entry.id)),
	})).filter((group) => group.permissions.length > 0);
}

/**
 * Narrows an arbitrary string to a known permission.
 *
 * Needed because Prisma types the stored column as `string`; a row written by an older version, or
 * edited by hand, must not silently widen what an account can do.
 *
 * @param value the candidate identifier
 * @returns whether the value is a currently defined permission
 */
export function isPanelPermission(value: string): value is PanelPermission {
	return (PANEL_PERMISSION_IDS as readonly string[]).includes(value);
}

/**
 * Filters stored identifiers down to the ones still recognised.
 *
 * Unknown values are dropped rather than causing a failure, so removing a permission from this file
 * degrades an account's authority instead of breaking every page it opens. Dropping is safe in a
 * way that keeping would not be: an unrecognised grant must never be treated as allowing something.
 *
 * @param stored identifiers as read from the database
 * @returns the subset that is currently defined
 */
export function parseStoredPanelPermissions(stored: readonly string[]): PanelPermission[] {
	return stored.filter(isPanelPermission);
}
