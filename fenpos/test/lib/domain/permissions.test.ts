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
		expect(parseStoredPermissions(["print", "assets:read", "from-an-older-build"])).toEqual(["print", "assets:read"]);
	});
});
