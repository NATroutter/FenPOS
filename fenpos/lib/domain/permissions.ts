import { z } from "zod";

/**
 * The closed set of permissions an API key may be granted.
 *
 * Permissions are stored one row per grant in `api_key_permissions`, so a key with no rows
 * can do nothing. That default matters: a key created but not yet configured must be inert,
 * never permissive.
 *
 * **Every identifier is `resource:verb`.** Submitting a job was `print` alone for as long as it was
 * the only thing a key could do, and it stayed that way past the point where eight others had joined
 * it — so the list an operator reads began with the one entry that did not look like the rest. It is
 * `jobs:submit` now, beside `jobs:read` and `jobs:cancel`, which is what it always was: the grant
 * that creates a job. `20260902001500_rename_print_permission` rewrites the stored rows, because an
 * unrecognised grant is dropped by {@link parseStoredPermissions} and every existing key would
 * otherwise have quietly stopped printing.
 *
 * Raw ESC/POS writes are in this set, and are the one grant here that is not sufficient on its own.
 * They hand arbitrary bytes to hardware, bypassing every content limit, codepage check and width
 * calculation the compiler applies — so `devices:raw` is gated a second time by the install-level
 * `link.allowRawApiWrites` setting, which ships off (`lib/settings/settings-service.ts`).
 * `POST /devices/{agent}/{device}/raw` reads that setting on every call, so granting the permission
 * on an install that has not enabled it grants nothing at all. That is the intended design: turning
 * this on takes two deliberate decisions by two different kinds of thinking, "this key may" and
 * "this install does". The description below says so in the present tense, and the route is what
 * makes it true.
 */

/** One permission and the description shown beside its checkbox in the admin panel. */
export interface PermissionDefinition {
	/** Stable identifier persisted in the database and checked at every API boundary. */
	readonly id: Permission;
	/** Human-readable explanation for the admin panel. Not part of any contract. */
	readonly description: string;
}

/**
 * Permission identifiers.
 *
 * Declared as a tuple so the type, the Zod schema, and the panel's checkbox list all derive
 * from one declaration and cannot fall out of step.
 */
export const PERMISSION_IDS = [
	"jobs:submit",
	"jobs:read",
	"jobs:cancel",
	"devices:read",
	"devices:control",
	"status:read",
	"assets:read",
	"assets:write",
	"devices:raw",
] as const;

export type Permission = (typeof PERMISSION_IDS)[number];

/** Validates a permission identifier arriving from a request body or a database row. */
export const permissionSchema = z.enum(PERMISSION_IDS);

/**
 * Permission definitions in the order the admin panel should render them, coarsest first.
 */
export const PERMISSIONS: readonly PermissionDefinition[] = [
	{
		id: "jobs:submit",
		description: "Submit print jobs to the devices this key grants.",
	},
	{
		id: "jobs:read",
		description: "Read the state of jobs this key submitted.",
	},
	{
		id: "jobs:cancel",
		description: "Cancel a queued job that has not started printing.",
	},
	{
		id: "devices:read",
		description: "Read device configuration and connection state.",
	},
	{
		id: "devices:control",
		description: "Pause, resume, connect, disconnect, and clear device queues.",
	},
	{
		id: "status:read",
		description: "Read agent and device health beyond the public liveness probe.",
	},
	{
		id: "assets:read",
		description: "List the stored images that markup can reference.",
	},
	{
		id: "assets:write",
		description: "Upload, import and delete stored images. Install-wide: assets are not scoped to a key's devices.",
	},
	{
		id: "devices:raw",
		description:
			"Send raw ESC/POS bytes straight to a printer, bypassing every content check. Also requires the 'Allow raw API writes' setting, which is off by default.",
	},
];

/**
 * Narrows an arbitrary string to a known permission.
 *
 * Needed because Prisma types the stored column as `string`; a row written by an older
 * version, or edited by hand, must not silently widen what a key can do.
 *
 * @param value the candidate identifier
 * @returns whether the value is a currently defined permission
 */
export function isPermission(value: string): value is Permission {
	return (PERMISSION_IDS as readonly string[]).includes(value);
}

/**
 * Filters stored permission strings down to the ones still recognised.
 *
 * Unknown values are dropped rather than causing a failure, so removing a permission from
 * this file degrades an old key's authority instead of breaking every request it makes.
 * Dropping is safe in a way that keeping would not be: an unrecognised grant must never be
 * treated as allowing something.
 *
 * @param stored permission identifiers as read from the database
 * @returns the subset that is currently defined
 */
export function parseStoredPermissions(stored: readonly string[]): Permission[] {
	return stored.filter(isPermission);
}
