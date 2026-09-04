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
 * An entry's `id` is what the audit record stores in `action`, for every entry without exception. It
 * usually equals the permission, and deliberately does not where two exports share one:
 * `replaceAsset` and `replaceAssetFromUrl` both require `assets:replace`, and a row saying which of
 * them ran is worth more than one that cannot tell them apart.
 *
 * **Most entries keep that true by construction; a handful keep it true by hand.** `panel-action.ts`'s
 * `record()` writes `action: id` straight from the entry, so a `command`, a `query` and most of the
 * `self` actions cannot drift. The `unauthenticated` entries and `auth:sign-out` are written by the
 * actions themselves, through `AUTH_AUDIT_ACTIONS` (`lib/audit/auth-events.ts`), and `settings:save`
 * through a literal of its own — so for those the id here and the string written there are two
 * spellings that have to agree. The two `archives:*` reads write all of their own rows, for the
 * reason their block below gives, so they are in that set too. `audit:archive-delete`, which lives in
 * the same module, does not: it is an ordinary `command`, and the gate writes its row from this entry
 * like any other. They did not agree, once: `signOut` was registered as `self:sign-out` while recording
 * `auth:sign-out`, which made the sentence above false and offered `/audit` a filter that could only
 * ever return no rows. If you add an entry whose action writes its own row, make the two match, and
 * prefer the `AUTH_AUDIT_ACTIONS` constant to a second literal.
 *
 * That agreement is no longer left to a reading. `test/lib/auth/registry-coverage.test.ts` collects
 * every action string written from a module under `app/` that calls `recordAudit` — an
 * `AUTH_AUDIT_ACTIONS` member or a bare literal — and fails on any that names no entry here, which is
 * exactly the shape the `self:sign-out` mismatch had. The sentence above is now checked, not just
 * asserted.
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
 * **`kind` decides what is written; it does not decide which wrapper an action uses.** Fifteen
 * actions shape their own result and therefore go through `panelQuery` rather than `panelAction` —
 * minting a key returns the secret, scanning ports returns the ports — and most of those are
 * `command` all the same, because they change something and their success belongs in the record.
 * The two axes are independent, and conflating them would quietly stop auditing key creation.
 *
 * `custom` is for the actions the gate genuinely cannot check, and there are three. `saveSettings`'s
 * batch spans setting categories and it checks one permission per staged change. `archives:list` and
 * `archives:read` are governed by `logs:read` or `audit:read` depending on which period the call names,
 * so the governing permission is a fact about the argument rather than about the action — see their
 * block below. What the three have in common is that no single `permission` string could be written
 * here without being wrong for some calls, which is the bar for using this kind: an action that merely
 * wants to check something extra should still be `command` or `query` and check it in addition.
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
	// `query`, like the two list-more actions beside it on the Audit and Logs tabs: it runs on every
	// approach to the bottom of an infinite-scrolled table, so a row per scroll would bury the one
	// action on this tab worth recording.
	{
		id: "jobs:list-more",
		kind: "query",
		permission: "jobs:read",
		module: "(panel)/jobs/actions.ts",
		exportName: "listMoreJobs",
		description: "Loaded the next batch of jobs for infinite scroll",
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
		// The "not gated, deliberately" actions are the ones acting on your *own* account, and setting
		// somebody else's avatar is not one of those. So this pair gets a real permission —
		// `users:update`, the same one that governs the name and email beside it — rather than the free
		// pass `self:set-avatar`/`self:remove-avatar` get.
		id: "users:set-avatar",
		kind: "command",
		permission: "users:update",
		module: "(panel)/users/actions.ts",
		exportName: "setUserAvatar",
		description: "Set an account's avatar",
	},
	{
		id: "users:remove-avatar",
		kind: "command",
		permission: "users:update",
		module: "(panel)/users/actions.ts",
		exportName: "removeUserAvatar",
		description: "Removed an account's avatar",
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

	{
		id: "users:list-sessions",
		kind: "query",
		permission: "users:read",
		module: "(panel)/users/actions.ts",
		exportName: "listSessions",
		description: "Listed an account's sessions",
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

	// --- Logs ---
	// One action, because this tab records nothing else at all: everything here is a read, and the
	// only one worth a server round trip beyond the page's own first batch is the infinite scroll's.
	{
		id: "logs:list-more",
		kind: "query",
		permission: "logs:read",
		module: "(panel)/logs/actions.ts",
		exportName: "listMoreLogs",
		description: "Loaded the next batch of log lines for infinite scroll",
	},

	// --- Audit ---
	// All three are reads, and the first two are `command`. `kind` decides what is written, not what
	// the action does: a `query` stays quiet about succeeding because `preview` runs on every
	// keystroke, and neither of those two does. Verification is a button press, and an export is
	// somebody taking a copy of the record away with them — the single most worth-recording read in
	// the system.
	{
		id: "audit:verify",
		kind: "command",
		permission: "audit:verify",
		module: "(panel)/audit/actions.ts",
		exportName: "verifyChain",
		description: "Walked the audit chain and reported whether it is whole",
	},
	{
		id: "audit:export",
		kind: "command",
		permission: "audit:export",
		module: "(panel)/audit/actions.ts",
		exportName: "exportAuditCsv",
		description: "Exported a filtered range of the audit record",
	},
	// The third one is where `query` earns its keep: the tab's signpost asks this on every render of a
	// filtered view, so a recorded success would be a row per page load and would bury the two above.
	// Being refused and being broken are still written, which is the whole of what `query` gives up and
	// the whole of what it keeps.
	{
		id: "audit:archive-covering",
		kind: "query",
		permission: "audit:read",
		module: "(panel)/audit/actions.ts",
		exportName: "auditArchiveCovering",
		description: "Looked for the archived month a filtered range reaches into",
	},
	// Also `query`, and for the same reason as the one above it: it runs on every approach to the
	// bottom of the tab's infinite-scrolled table, so a row per scroll would bury the two commands
	// this tab actually records.
	{
		id: "audit:list-more",
		kind: "query",
		permission: "audit:read",
		module: "(panel)/audit/actions.ts",
		exportName: "listMoreAuditEvents",
		description: "Loaded the next batch of events for infinite scroll",
	},

	// --- Archives ---
	// `custom`, for the reason the kind exists: the gate cannot check for these. Reading an archive is
	// reading the same data through a different file, so this plan adds no permission for it — a log
	// period is `logs:read` and an audit period is `audit:read`, and **which one governs a call is
	// decided by the call's own argument.** A single `permission` here could only ever be right for one
	// of the two sources, and naming either would lock the other's readers out of the tab entirely.
	//
	// So both resolve the session through `panelSelf` and check per source, and both write every row
	// they owe — a `DENIED` naming the permission the caller was missing, a `FAILURE` when the archive
	// directory could not be read. Neither records success: arriving at the tab lists, and an operator
	// hunting through a period opens it over and over, so a row per success would bury the rows worth
	// reading. That is the `query` argument, kept, even though the kind could not be.
	//
	// The cost is that `permission-matrix.test.ts` walks only `command` and `query`, so these two are
	// not covered by it. `test/app/(panel)/archives/actions.test.ts` proves both gates directly instead
	// — refused holding neither, allowed holding either, and refused per source in both directions.
	{
		id: "archives:list",
		kind: "custom",
		permission: null,
		module: "(panel)/archives/actions.ts",
		exportName: "listArchivePeriods",
		description: "Listed the archived periods on disk",
	},
	{
		id: "archives:read",
		kind: "custom",
		permission: null,
		module: "(panel)/archives/actions.ts",
		exportName: "readArchivePage",
		description: "Opened an archived period and read a page of it",
	},
	// The third action on this tab, and deliberately not shaped like the two above it. It has exactly
	// one permission — deleting an archived audit period is never governed by anything else — so it is
	// an ordinary `command`, which keeps it inside `permission-matrix.test.ts`'s per-entry coverage that
	// the two `custom` entries had to give up. `custom` is for an action the gate cannot check, not for
	// an action that happens to sit beside two of them.
	//
	// A permission of its own rather than `audit:export`, which is the nearest existing fit and the
	// wrong one: an export is read-shaped, so reusing it would mean anyone who can produce a report can
	// destroy evidence.
	{
		id: "audit:archive-delete",
		kind: "command",
		permission: "audit:archive-delete",
		module: "(panel)/archives/actions.ts",
		exportName: "deleteAuditArchive",
		description: "Deleted an archived audit period and moved the epoch behind it",
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
		id: "self:set-avatar",
		kind: "self",
		permission: null,
		module: "(panel)/settings/actions.ts",
		exportName: "setOwnAvatar",
		description: "Set their own avatar",
	},
	{
		id: "self:remove-avatar",
		kind: "self",
		permission: null,
		module: "(panel)/settings/actions.ts",
		exportName: "removeOwnAvatar",
		description: "Removed their own avatar",
	},
	{
		// `auth:sign-out`, not `self:sign-out`, though this sits among the `self` entries and its `kind`
		// stays `self`: the id has to be the string the row actually carries, and `signOut` records
		// `AUTH_AUDIT_ACTIONS.SIGN_OUT`. The stored value is the authority here, since
		// `AuditEvent` has no edit path by design and every row any install has ever written says
		// `auth:sign-out` — renaming the other way would leave those rows unfindable. It reads correctly
		// too: signing out is an auth lifecycle event beside `auth:sign-in` and `auth:set-password`.
		//
		// `sign-out.ts`, not `(panel)/layout.tsx` where it began as an inline action: the two gate
		// pages under `(auth)` sit outside that layout and need the same way out, so it moved to a
		// module all three can import.
		id: "auth:sign-out",
		kind: "self",
		permission: null,
		module: "sign-out.ts",
		exportName: "signOut",
		description: "Signed out of the panel",
	},
	{
		id: "self:begin-2fa",
		kind: "self",
		permission: null,
		module: "(panel)/settings/actions.ts",
		exportName: "startTwoFactor",
		description: "Started two-factor enrolment",
	},
	{
		id: "self:confirm-2fa",
		kind: "self",
		permission: null,
		module: "(panel)/settings/actions.ts",
		exportName: "confirmTwoFactor",
		description: "Confirmed two-factor enrolment",
	},
	{
		id: "self:end-2fa",
		kind: "self",
		permission: null,
		module: "(panel)/settings/actions.ts",
		exportName: "stopTwoFactor",
		description: "Turned off their own two-factor",
	},

	// --- No session to check a permission against. The setup pair is governed by the seal in
	// `lib/auth/setup.ts` instead. All five already write their own audit rows, so the gate does not
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
		id: "auth:two-factor",
		kind: "unauthenticated",
		permission: null,
		module: "(auth)/login/actions.ts",
		exportName: "verifyTwoFactor",
		description: "Presented a second factor at sign-in",
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
