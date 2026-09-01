import { describe, expect, it } from "vitest";
import { isPermission, PERMISSION_IDS, PERMISSIONS, parseStoredPermissions } from "@/lib/domain/permissions";

/**
 * The closed set of things a key may be granted.
 *
 * These identifiers are stored in `api_key_permissions`, so this is a database contract as much as
 * a type. Adding one is safe; renaming or removing one silently reduces what every key holding it
 * can do, which is why the descriptions and the ids are checked together — a description added
 * without an id, or the reverse, is a checkbox in the panel that grants nothing.
 */

describe("permission set", () => {
	it("declares a description for every id, and no orphans", () => {
		expect(PERMISSIONS.map((permission) => permission.id).sort()).toEqual([...PERMISSION_IDS].sort());
	});

	it("includes the asset permissions", () => {
		expect(PERMISSION_IDS).toContain("assets:read");
		expect(PERMISSION_IDS).toContain("assets:write");
	});

	it("recognises them as permissions", () => {
		expect(isPermission("assets:write")).toBe(true);
		expect(isPermission("assets:destroy")).toBe(false);
	});

	it("drops stored values it no longer recognises, rather than widening authority", () => {
		expect(parseStoredPermissions(["jobs:submit", "assets:read", "from-an-older-build"])).toEqual([
			"jobs:submit",
			"assets:read",
		]);
	});
});

describe("devices:raw", () => {
	it("is a permission a key can hold", () => {
		expect(PERMISSION_IDS).toContain("devices:raw");
		expect(isPermission("devices:raw")).toBe(true);
	});

	it("has a description that says an install setting also gates it", () => {
		// The permission alone does not grant the capability, and an operator ticking this box needs
		// to know that from the box itself — otherwise they grant it, the endpoint keeps refusing,
		// and the reason is in a settings page they had no cause to visit.
		const definition = PERMISSIONS.find((permission) => permission.id === "devices:raw");

		expect(definition?.description).toMatch(/setting/i);
	});

	it("is listed last, after every permission that grants less", () => {
		// The panel renders this order. The most dangerous grant belongs at the bottom of the list,
		// not in the middle of it where it reads as one checkbox among equals.
		expect(PERMISSION_IDS[PERMISSION_IDS.length - 1]).toBe("devices:raw");
	});
});
