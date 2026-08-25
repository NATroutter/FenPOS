import type { PanelPermission } from "@/lib/domain/panel-permissions";

/**
 * Every server action the panel exposes, and what it takes to call one.
 *
 * One central list rather than a check inside each action, and that choice is the point: a test
 * walks `app/` for `"use server"` exports and fails when one is not named here, which turns
 * "somebody added an action and forgot to gate it" from a question review might catch into a build
 * failure it cannot miss. A per-file helper could not do that — there would be nothing to compare
 * the filesystem against.
 *
 * An entry's `id` is what the audit record stores in `action`. It usually equals the permission,
 * and deliberately does not where two exports share one: `replaceAsset` and `replaceAssetFromUrl`
 * both require `assets:replace`, and a row saying which of them ran is worth more than one that
 * cannot tell them apart.
 */

/**
 * How an action is gated, and what it writes.
 *
 * `query` is the one that needs arguing for. Applied literally, "every registry entry writes
 * SUCCESS, DENIED and FAILURE" means a row every time somebody types a character into the Tools
 * editor, because `preview` runs as they type. The case against auditing successful API reads —
 * that the volume would bury everything else — applies here with more force, since nothing
 * rate-limits these. So a query records being refused and being broken, and stays quiet about
 * working. Permission probing is still visible in the log, which is the property actually argued
 * for. When the `audit.*` settings arrive, a setting can turn query successes on.
 *
 * **`kind` decides what is written; it does not decide which wrapper an action uses.** Eleven
 * actions shape their own result and therefore go through `panelQuery` rather than `panelAction` —
 * minting a key returns the secret, scanning ports returns the ports — and most of those are
 * `command` all the same, because they change something and their success belongs in the record.
 * The two axes are independent, and conflating them would quietly stop auditing key creation.
 *
 * `custom` is `saveSettings` alone: its batch spans setting categories and it checks one permission
 * per staged change, so the gate cannot check for it.
 *
 * `self` and `unauthenticated` carry no permission and exist so "deliberately ungated" is a
 * decision written down rather than an absence the coverage test has to be told to forgive.
 */
export type PanelActionKind = "command" | "query" | "custom" | "self" | "unauthenticated";

/** One action, and what calling it takes. */
export interface PanelActionEntry {
	/** Stored in `AuditEvent.action`. Unique across the registry. */
	readonly id: string;
	readonly kind: PanelActionKind;
	/** Required for `command` and `query`; null for every other kind. */
	readonly permission: PanelPermission | null;
	/** The module the export lives in, relative to `app/`, with forward slashes. */
	readonly module: string;
	/** The exported function's name. */
	readonly exportName: string;
	/** One line describing what happened, for whoever reads the audit row. */
	readonly description: string;
}

/**
 * The registry.
 *
 * Ordered by the page each action belongs to, so a reader checking that a tab is fully covered
 * reads one contiguous block rather than hunting.
 */
export const PANEL_ACTIONS = [
	// --- Agents ---
	{
		id: "agents:create",
		kind: "command",
		permission: "agents:create",
		module: "(panel)/agents/actions.ts",
		exportName: "createAgent",
		description: "Added an agent",
	},
	{
		id: "agents:rename",
		kind: "command",
		permission: "agents:rename",
		module: "(panel)/agents/actions.ts",
		exportName: "renameAgent",
		description: "Renamed an agent",
	},
	{
		id: "agents:pairing-code",
		kind: "command",
		permission: "agents:pairing-code",
		module: "(panel)/agents/actions.ts",
		exportName: "refreshPairingCode",
		description: "Issued a fresh pairing code",
	},
	{
		id: "agents:unpair",
		kind: "command",
		permission: "agents:unpair",
		module: "(panel)/agents/actions.ts",
		exportName: "unpairAgent",
		description: "Unpaired an agent",
	},
	{
		id: "agents:delete",
		kind: "command",
		permission: "agents:delete",
		module: "(panel)/agents/actions.ts",
		exportName: "deleteAgent",
		description: "Deleted an agent",
	},
	{
		id: "agents:test-print",
		kind: "command",
		permission: "agents:test-print",
		module: "(panel)/agents/actions.ts",
		exportName: "sendTestPrint",
		description: "Sent a server-composed test job",
	},

	// --- Devices ---
	{
		id: "devices:create",
		kind: "command",
		permission: "devices:create",
		module: "(panel)/devices/actions.ts",
		exportName: "createDevice",
		description: "Added a printer",
	},
	{
		id: "devices:update",
		kind: "command",
		permission: "devices:update",
		module: "(panel)/devices/actions.ts",
		exportName: "updateDevice",
		description: "Changed a printer's configuration",
	},
	{
		id: "devices:delete",
		kind: "command",
		permission: "devices:delete",
		module: "(panel)/devices/actions.ts",
		exportName: "deleteDevice",
		description: "Deleted a printer",
	},
	{
		id: "devices:pause",
		kind: "command",
		permission: "devices:pause",
		module: "(panel)/devices/actions.ts",
		exportName: "setPaused",
		description: "Paused or resumed a printer",
	},
	{
		id: "devices:connect",
		kind: "command",
		permission: "devices:connect",
		module: "(panel)/devices/actions.ts",
		exportName: "setConnected",
		description: "Connected or disconnected a printer",
	},
	{
		id: "devices:clear-queue",
		kind: "command",
		permission: "devices:clear-queue",
		module: "(panel)/devices/actions.ts",
		exportName: "clearQueue",
		description: "Discarded a printer's queue",
	},
	{
		id: "devices:test-page",
		kind: "command",
		permission: "devices:test-page",
		module: "(panel)/devices/actions.ts",
		exportName: "printTestPage",
		description: "Printed the agent's diagnostic page",
	},
	{
		id: "devices:override",
		kind: "command",
		permission: "devices:override",
		module: "(panel)/devices/actions.ts",
		exportName: "saveDeviceOverride",
		description: "Changed a printer's limit overrides",
	},
	{
		id: "devices:scan-ports",
		kind: "command",
		permission: "devices:scan-ports",
		module: "(panel)/devices/actions.ts",
		exportName: "scanAgentPorts",
		description: "Scanned an agent's ports",
	},

	// --- Jobs ---
	{
		id: "jobs:cancel",
		kind: "command",
		permission: "jobs:cancel",
		module: "(panel)/jobs/actions.ts",
		exportName: "cancelJob",
		description: "Cancelled a queued job",
	},

	// --- Tools ---
	{
		id: "tools:preview",
		kind: "query",
		permission: "tools:preview",
		module: "(panel)/tools/actions.ts",
		exportName: "preview",
		description: "Previewed markup",
	},
	{
		id: "tools:print",
		kind: "command",
		permission: "tools:print",
		module: "(panel)/tools/actions.ts",
		exportName: "printMarkup",
		description: "Printed composed markup",
	},
	{
		id: "tools:raw",
		kind: "command",
		permission: "tools:raw",
		module: "(panel)/tools/actions.ts",
		exportName: "writeRaw",
		description: "Wrote raw bytes to a printer",
	},
	{
		id: "tools:list-images",
		kind: "query",
		permission: "tools:read",
		module: "(panel)/tools/actions.ts",
		exportName: "listMarkupImages",
		description: "Listed the images markup can name",
	},
	{
		id: "tools:list-variables",
		kind: "query",
		permission: "tools:read",
		module: "(panel)/tools/actions.ts",
		exportName: "listMarkupVariables",
		description: "Listed the variables markup can name",
	},

	// --- Assets ---
	{
		id: "assets:upload",
		kind: "command",
		permission: "assets:upload",
		module: "(panel)/assets/actions.ts",
		exportName: "uploadAsset",
		description: "Uploaded an image",
	},
	{
		id: "assets:import",
		kind: "command",
		permission: "assets:import",
		module: "(panel)/assets/actions.ts",
		exportName: "importAsset",
		description: "Imported an image from a URL",
	},
	{
		id: "assets:rename",
		kind: "command",
		permission: "assets:rename",
		module: "(panel)/assets/actions.ts",
		exportName: "renameAsset",
		description: "Renamed an image",
	},
	{
		id: "assets:replace",
		kind: "command",
		permission: "assets:replace",
		module: "(panel)/assets/actions.ts",
		exportName: "replaceAsset",
		description: "Replaced an image's bytes",
	},
	{
		id: "assets:replace-from-url",
		kind: "command",
		permission: "assets:replace",
		module: "(panel)/assets/actions.ts",
		exportName: "replaceAssetFromUrl",
		description: "Replaced an image's bytes from a URL",
	},
	{
		id: "assets:delete",
		kind: "command",
		permission: "assets:delete",
		module: "(panel)/assets/actions.ts",
		exportName: "removeAsset",
		description: "Removed an image",
	},

	// --- Variables ---
	{
		id: "variables:create",
		kind: "command",
		permission: "variables:create",
		module: "(panel)/variables/actions.ts",
		exportName: "createVariable",
		description: "Added a variable",
	},
	{
		id: "variables:update",
		kind: "command",
		permission: "variables:update",
		module: "(panel)/variables/actions.ts",
		exportName: "updateVariable",
		description: "Changed a variable",
	},
	{
		id: "variables:delete",
		kind: "command",
		permission: "variables:delete",
		module: "(panel)/variables/actions.ts",
		exportName: "removeVariable",
		description: "Removed a variable",
	},
	{
		id: "variables:preview",
		kind: "query",
		permission: "variables:preview",
		module: "(panel)/variables/actions.ts",
		exportName: "previewMoment",
		description: "Previewed a date pattern",
	},

	// --- API keys ---
	{
		id: "keys:create",
		kind: "command",
		permission: "keys:create",
		module: "(panel)/keys/actions.ts",
		exportName: "createKey",
		description: "Minted an API key",
	},
	{
		id: "keys:update",
		kind: "command",
		permission: "keys:update",
		module: "(panel)/keys/actions.ts",
		exportName: "updateKey",
		description: "Changed an API key's grants",
	},
	{
		id: "keys:reroll",
		kind: "command",
		permission: "keys:reroll",
		module: "(panel)/keys/actions.ts",
		exportName: "rerollKey",
		description: "Replaced an API key's secret",
	},
	{
		id: "keys:rename",
		kind: "command",
		permission: "keys:rename",
		module: "(panel)/keys/actions.ts",
		exportName: "renameKey",
		description: "Renamed an API key",
	},
	{
		id: "keys:revoke",
		kind: "command",
		permission: "keys:revoke",
		module: "(panel)/keys/actions.ts",
		exportName: "revokeKey",
		description: "Revoked an API key",
	},
	{
		id: "keys:delete",
		kind: "command",
		permission: "keys:delete",
		module: "(panel)/keys/actions.ts",
		exportName: "deleteKey",
		description: "Deleted an API key",
	},
	{
		id: "keys:webhook-set",
		kind: "command",
		permission: "keys:webhook-set",
		module: "(panel)/keys/actions.ts",
		exportName: "setWebhook",
		description: "Pointed a key's notifications at a URL",
	},
	{
		id: "keys:webhook-remove",
		kind: "command",
		permission: "keys:webhook-remove",
		module: "(panel)/keys/actions.ts",
		exportName: "removeWebhook",
		description: "Stopped a key's notifications",
	},

	// --- Users ---
	{
		id: "users:create",
		kind: "command",
		permission: "users:create",
		module: "(panel)/users/actions.ts",
		exportName: "createUser",
		description: "Created an account",
	},
	{
		id: "users:update",
		kind: "command",
		permission: "users:update",
		module: "(panel)/users/actions.ts",
		exportName: "updateUser",
		description: "Changed an account's name or email",
	},
	{
		id: "users:set-password",
		kind: "command",
		permission: "users:set-password",
		module: "(panel)/users/actions.ts",
		exportName: "setUserPassword",
		description: "Set another account's password",
	},
	{
		id: "users:force-reset",
		kind: "command",
		permission: "users:force-reset",
		module: "(panel)/users/actions.ts",
		exportName: "forcePasswordReset",
		description: "Required an account to replace its password",
	},
	{
		id: "users:ban",
		kind: "command",
		permission: "users:ban",
		module: "(panel)/users/actions.ts",
		exportName: "banUser",
		description: "Banned an account",
	},
	{
		id: "users:unban",
		kind: "command",
		permission: "users:unban",
		module: "(panel)/users/actions.ts",
		exportName: "unbanUser",
		description: "Lifted an account's ban",
	},
	{
		id: "users:revoke-session",
		kind: "command",
		permission: "users:revoke-sessions",
		module: "(panel)/users/actions.ts",
		exportName: "revokeUserSession",
		description: "Ended one of an account's sessions",
	},
	{
		id: "users:revoke-sessions",
		kind: "command",
		permission: "users:revoke-sessions",
		module: "(panel)/users/actions.ts",
		exportName: "revokeUserSessions",
		description: "Ended every session an account held",
	},
	{
		id: "users:delete",
		kind: "command",
		permission: "users:delete",
		module: "(panel)/users/actions.ts",
		exportName: "deleteUser",
		description: "Deleted an account",
	},
	{
		id: "users:set-roles",
		kind: "command",
		permission: "users:grant",
		module: "(panel)/users/actions.ts",
		exportName: "setUserRoles",
		description: "Changed which roles an account holds",
	},
	{
		id: "users:set-permissions",
		kind: "command",
		permission: "users:grant",
		module: "(panel)/users/actions.ts",
		exportName: "setUserPermissions",
		description: "Changed an account's individual permissions",
	},
	{
		id: "users:disable-2fa",
		kind: "command",
		permission: "users:disable-2fa",
		module: "(panel)/users/actions.ts",
		exportName: "disableTwoFactor",
		description: "Cleared an account's two-factor enrolment",
	},
	{
		id: "users:set-superuser",
		kind: "command",
		permission: "users:set-superuser",
		module: "(panel)/users/actions.ts",
		exportName: "setSuperuser",
		description: "Promoted or demoted a superuser",
	},

	// --- Roles ---
	{
		id: "roles:create",
		kind: "command",
		permission: "roles:create",
		module: "(panel)/roles/actions.ts",
		exportName: "createRole",
		description: "Created a role",
	},
	{
		id: "roles:update",
		kind: "command",
		permission: "roles:update",
		module: "(panel)/roles/actions.ts",
		exportName: "updateRole",
		description: "Changed a role's permissions or membership",
	},
	{
		id: "roles:delete",
		kind: "command",
		permission: "roles:delete",
		module: "(panel)/roles/actions.ts",
		exportName: "deleteRole",
		description: "Deleted a role",
	},

	// --- Settings ---
	{
		id: "settings:save",
		kind: "custom",
		permission: null,
		module: "(panel)/settings/actions.ts",
		exportName: "saveSettings",
		description: "Changed install settings",
	},

	// --- The caller's own account. Never gated: every authenticated user must be able to do these,
	// and gating the password one would let somebody be locked out of the forced reset standing
	// between them and the panel. Still audited.
	{
		id: "self:change-password",
		kind: "self",
		permission: null,
		module: "(panel)/settings/actions.ts",
		exportName: "changePassword",
		description: "Changed their own password",
	},
	{
		id: "self:update-profile",
		kind: "self",
		permission: null,
		module: "(panel)/settings/actions.ts",
		exportName: "updateProfile",
		description: "Changed their own name or email",
	},
	{
		id: "self:sign-out",
		kind: "self",
		permission: null,
		module: "(panel)/layout.tsx",
		exportName: "signOut",
		description: "Signed out of the panel",
	},

	// --- No session to check a permission against. The setup pair is governed by the seal in
	// `lib/auth/setup.ts` instead. All four already write their own audit rows, so the gate does not
	// touch them — they are here to be accounted for, not to be wrapped.
	{
		id: "auth:sign-in",
		kind: "unauthenticated",
		permission: null,
		module: "(auth)/login/actions.ts",
		exportName: "signIn",
		description: "Presented credentials at sign-in",
	},
	{
		id: "auth:set-password",
		kind: "unauthenticated",
		permission: null,
		module: "(auth)/set-password/actions.ts",
		exportName: "setPassword",
		description: "Completed a forced password change",
	},
	{
		id: "setup:key-check",
		kind: "unauthenticated",
		permission: null,
		module: "(auth)/setup/actions.ts",
		exportName: "checkSetupKey",
		description: "Presented a setup key",
	},
	{
		id: "setup:complete",
		kind: "unauthenticated",
		permission: null,
		module: "(auth)/setup/actions.ts",
		exportName: "runSetup",
		description: "Claimed the install",
	},
] as const satisfies readonly PanelActionEntry[];

/** The id of any registered action. */
export type PanelActionId = (typeof PANEL_ACTIONS)[number]["id"];

/**
 * Finds an action by its id.
 *
 * Throws rather than returning undefined, deliberately: every caller is a gate about to decide
 * whether somebody may proceed, and the only sane answer to "I cannot find the rule" is to stop. A
 * permissive default here would be a hole shaped exactly like a typo.
 *
 * @param id the action's registry id
 * @returns its entry
 * @throws Error when the id is not registered
 */
export function panelActionEntry(id: PanelActionId): PanelActionEntry {
	const entry = PANEL_ACTIONS.find((candidate) => candidate.id === id);
	if (!entry) {
		throw new Error(`No registry entry for panel action "${id}"`);
	}
	return entry;
}

/**
 * Finds an action by the file and export it lives in.
 *
 * For the coverage test, which reads the filesystem and needs to ask the registry whether what it
 * found is accounted for.
 *
 * @param module path relative to `app/`, with forward slashes
 * @param exportName the exported function's name
 * @returns the entry, or undefined when nothing claims that export
 */
export function registryEntryFor(module: string, exportName: string): PanelActionEntry | undefined {
	return PANEL_ACTIONS.find((entry) => entry.module === module && entry.exportName === exportName);
}
