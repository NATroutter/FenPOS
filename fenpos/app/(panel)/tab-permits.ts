import type { PanelPermission } from "@/lib/domain/panel-permissions";

/**
 * Which permissions each tab's controls are gated on.
 *
 * **This module must never be a Client Component, and that is the whole reason it exists.** These
 * lists started out beside the controls they describe, in the `"use client"` modules — which looks
 * right and does not work. Next replaces a client module's exports with client references when a
 * Server Component imports them, so a page that did `permitsFor(user, AGENT_PERMISSIONS)` was
 * handing `permitsFor` a proxy rather than an array, and the tab died on `permissions.map is not a
 * function`. A plain module is importable from both sides: the pages read the tuples, the
 * components import only the types, and types are erased.
 *
 * Keeping every tab's list in one file has turned out to be worth more than proximity anyway. The
 * question this file answers — what can an operator holding only `<x>:read` still see — is asked
 * about the panel, not about one tab, and it now has one place to be answered.
 *
 * **Convenience, never the boundary.** See `lib/auth/permits.ts`: every action behind these
 * controls is refused again on the server against the same permission.
 */

/** Turns a permission tuple into the flag-per-permission record `permitsFor` resolves it to. */
type Permits<T extends readonly PanelPermission[]> = Record<T[number], boolean>;

/** Agents: add, rename, reissue a pairing code, unpair, delete, test print. */
export const AGENT_PERMISSIONS = [
	"agents:create",
	"agents:rename",
	"agents:pairing-code",
	"agents:unpair",
	"agents:delete",
	"agents:test-print",
] as const;

export type AgentPermits = Permits<typeof AGENT_PERMISSIONS>;

/**
 * Devices: the card's action row, the Configure dialog, and the two things inside it that are
 * separate permissions of their own — the port scan and the per-printer variable overrides.
 */
export const DEVICE_PERMISSIONS = [
	"devices:create",
	"devices:update",
	"devices:delete",
	"devices:pause",
	"devices:connect",
	"devices:clear-queue",
	"devices:test-page",
	"devices:override",
	"devices:scan-ports",
] as const;

export type DevicePermits = Permits<typeof DEVICE_PERMISSIONS>;

/**
 * Tools: the paper preview, the Print button, and the raw-bytes card.
 *
 * `tools:read` alone lists the images and variables markup can name and nothing else, which is why
 * this tab is the one that can end up with no card to show at all.
 */
export const TOOL_PERMISSIONS = ["tools:preview", "tools:print", "tools:raw"] as const;

export type ToolPermits = Permits<typeof TOOL_PERMISSIONS>;

/**
 * Assets: the Add dialog and each card's rename, replace and delete.
 *
 * `assets:upload` and `assets:import` are the Add dialog's two sources rather than two buttons —
 * fetching a URL makes this server issue an outbound request, which uploading a file does not, so
 * they are granted separately even though they land in the same place.
 */
export const ASSET_PERMISSIONS = [
	"assets:upload",
	"assets:import",
	"assets:rename",
	"assets:replace",
	"assets:delete",
] as const;

export type AssetPermits = Permits<typeof ASSET_PERMISSIONS>;

/**
 * Variables: Add, each row's Edit and Delete, and the live "Prints now" reading inside the dialog.
 *
 * `variables:preview` renders a date pattern against the current instant, which is a server round
 * trip per pause in typing — so it is a grant of its own rather than something the edit form does
 * for free.
 */
export const VARIABLE_PERMISSIONS = [
	"variables:create",
	"variables:update",
	"variables:delete",
	"variables:preview",
] as const;

export type VariablePermits = Permits<typeof VARIABLE_PERMISSIONS>;

/** Jobs: cancelling one that has not started printing. Everything else on that tab is history. */
export const JOB_PERMISSIONS = ["jobs:cancel"] as const;

export type JobPermits = Permits<typeof JOB_PERMISSIONS>;

/** Archives: deleting an archived audit period. Held apart from reading it — it destroys evidence. */
export const ARCHIVE_PERMISSIONS = ["audit:archive-delete"] as const;

export type ArchivePermits = Permits<typeof ARCHIVE_PERMISSIONS>;
