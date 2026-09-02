import { describe, expect, it } from "vitest";
import {
	grantablePermissionGroups,
	isPanelPermission,
	NEVER_GRANTABLE,
	PANEL_PERMISSION_GROUPS,
	PANEL_PERMISSION_IDS,
	parseStoredPanelPermissions,
} from "@/lib/domain/panel-permissions";

/**
 * The closed set a panel user's grants are drawn from.
 *
 * These strings are a stored contract in two directions at once: rows in `user_permissions` and
 * `role_permissions` hold them, and every `AuditEvent` written by a gated action carries the
 * matching action id in a column covered by a hash. Renaming one does not migrate the grants — it
 * silently revokes them, because an unrecognised identifier is dropped on read.
 */
describe("panel permissions", () => {
	it("declares the complete set the spec names", () => {
		// Seventy-eight: seventy-five derived by walking every `"use server"` export that exists plus
		// every action phases 4 through 8 add, `settings:write:audit`, which that derivation could not
		// have counted because the `audit` settings category did not exist yet, and
		// `audit:archive-delete`, which nothing could have derived at all — deleting an archived audit
		// period is not a read of anything, and no existing permission could be widened to cover it
		// without letting somebody who may export the record destroy it — plus `settings:write:statistics`,
		// added with the "statistics" settings category. A count rather than a list, so adding one
		// deliberately is a one-line change and adding one accidentally is a failure.
		expect(PANEL_PERMISSION_IDS).toHaveLength(78);
	});

	it("names each identifier once", () => {
		expect(new Set(PANEL_PERMISSION_IDS).size).toBe(PANEL_PERMISSION_IDS.length);
	});

	it("groups every identifier exactly once", () => {
		const grouped = PANEL_PERMISSION_GROUPS.flatMap((group) => group.permissions.map((entry) => entry.id));

		// Both directions: a permission missing from the groups is one phase 4's checkbox list cannot
		// grant, and a permission listed twice is one an operator sees twice.
		expect(new Set(grouped).size).toBe(grouped.length);
		expect([...grouped].sort()).toEqual([...PANEL_PERMISSION_IDS].sort());
	});

	it("gives every identifier a description that is not the identifier", () => {
		for (const group of PANEL_PERMISSION_GROUPS) {
			for (const entry of group.permissions) {
				expect(entry.description.length).toBeGreaterThan(10);
				expect(entry.description).not.toBe(entry.id);
			}
		}
	});

	it("narrows a string read back from the database", () => {
		expect(isPanelPermission("devices:delete")).toBe(true);
		expect(isPanelPermission("devices:destroy")).toBe(false);
	});

	it("drops a stored identifier it no longer recognises", () => {
		// Dropping is safe in a way that keeping is not: an unrecognised grant must never be treated
		// as allowing something. The same rule `parseStoredPermissions` already applies to API keys.
		expect(parseStoredPanelPermissions(["devices:read", "devices:teleport"])).toEqual(["devices:read"]);
	});

	it("marks promoting a superuser as something no grant can hand out", () => {
		expect(NEVER_GRANTABLE).toContain("users:set-superuser");
	});

	it("has a write permission for every settings category", async () => {
		const { CATEGORIES } = await import("@/lib/settings/settings-service");

		// `permissionForSetting` in the Settings action casts `settings:write:${category}` to a
		// permission. Without this, adding a category silently makes its settings superuser-only,
		// and nothing else would say so.
		for (const category of CATEGORIES) {
			expect(PANEL_PERMISSION_IDS).toContain(`settings:write:${category.id}`);
		}
	});
});

describe("grantablePermissionGroups", () => {
	it("offers no checkbox for a permission no grant can hand out", () => {
		const offered = grantablePermissionGroups().flatMap((group) => group.permissions.map((entry) => entry.id));

		for (const permission of NEVER_GRANTABLE) {
			expect(offered).not.toContain(permission);
		}
	});

	it("offers every other permission exactly once", () => {
		const offered = grantablePermissionGroups().flatMap((group) => group.permissions.map((entry) => entry.id));

		expect(new Set(offered).size).toBe(offered.length);
		expect(offered.length).toBe(PANEL_PERMISSION_IDS.length - NEVER_GRANTABLE.length);
	});

	it("keeps the Users group, which loses one member but not all of them", () => {
		const users = grantablePermissionGroups().find((group) => group.label === "Users");

		expect(users?.permissions.map((entry) => entry.id)).toContain("users:grant");
		expect(users?.permissions.map((entry) => entry.id)).not.toContain("users:set-superuser");
	});

	it("drops a group that would render with nothing under it", () => {
		// Not reachable with today's NEVER_GRANTABLE, and asserted anyway: the filter is what would
		// have to be right on the day a whole group becomes ungrantable, and a heading over an empty
		// list is worse than no heading.
		for (const group of grantablePermissionGroups()) {
			expect(group.permissions.length).toBeGreaterThan(0);
		}
	});
});
