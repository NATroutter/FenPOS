import { describe, expect, it } from "vitest";
import { PANEL_PERMISSION_IDS } from "@/lib/domain/panel-permissions";
import { findNavItem, NAV_GROUPS, NAV_ITEMS, type NavItem } from "@/lib/navigation";
import { SETTINGS } from "@/lib/settings/settings-service";

/**
 * Tests for the navigation table.
 *
 * The one piece of real logic here is `findNavItem`, and it has a known failure mode: with child
 * entries flattened into `NAV_ITEMS`, `/docs` prefix-matches `/docs/api`, so a lookup that took the
 * first match would put the parent's title on every child page. Longest match is what fixes that,
 * and it is what will keep the header right for whatever nesting the operator guides bring.
 */

/** Every item in the tree, parents and children alike, walked from `NAV_GROUPS` directly. */
function everyItem(): NavItem[] {
	const found: NavItem[] = [];
	for (const group of NAV_GROUPS) {
		for (const item of group.items) {
			found.push(item, ...(item.children ?? []));
		}
	}
	return found;
}

describe("findNavItem", () => {
	it("resolves a child path to the child, not to the parent it nests under", () => {
		expect(findNavItem("/docs/api")?.href).toBe("/docs/api");
		expect(findNavItem("/docs/markup")?.href).toBe("/docs/markup");
	});

	it("resolves a path below a child to that child", () => {
		expect(findNavItem("/docs/markup/anything")?.href).toBe("/docs/markup");
	});

	it("resolves a parent's own path to the parent", () => {
		expect(findNavItem("/docs")?.href).toBe("/docs");
	});

	it("still resolves a nested route to the section that owns it", () => {
		expect(findNavItem("/devices/abc123")?.href).toBe("/devices");
	});

	it("resolves a path outside the panel to nothing", () => {
		expect(findNavItem("/nowhere")).toBeUndefined();
	});

	/**
	 * A path that merely starts with a section's href without being under it. `/docsomething` is not
	 * inside `/docs`, and a naive `startsWith(item.href)` would say it is.
	 */
	it("does not match a path that only shares a prefix with a section", () => {
		expect(findNavItem("/docsomething")).toBeUndefined();
	});
});

describe("NAV_ITEMS", () => {
	it("flattens children as well as group items", () => {
		const hrefs = NAV_ITEMS.map((item) => item.href);
		expect(hrefs).toContain("/docs");
		expect(hrefs).toContain("/docs/api");
		expect(hrefs).toContain("/docs/markup");
		expect(NAV_ITEMS).toHaveLength(everyItem().length);
	});

	/**
	 * The check that catches a child added to `NAV_GROUPS` and never flattened: such an entry would
	 * appear in the sidebar and give its page no title, no description and no active state.
	 */
	it("makes every href in the tree reachable through findNavItem", () => {
		for (const item of everyItem()) {
			expect(findNavItem(item.href)?.href, `${item.href} is not reachable`).toBe(item.href);
		}
	});

	it("gives every entry a label, a title and a description", () => {
		for (const item of everyItem()) {
			expect(item.label.length, `${item.href} has no label`).toBeGreaterThan(0);
			expect(item.title.length, `${item.href} has no title`).toBeGreaterThan(0);
			expect(item.description.length, `${item.href} has no description`).toBeGreaterThan(0);
		}
	});

	/**
	 * A section's switch must be a boolean setting this install defines: the sidebar filter and the
	 * page gate both read it through `booleanSetting`, which throws on any other kind of key, and the
	 * `/no-access` page names it by looking its label up. Statistics and Variables are the two that
	 * have one; the assertion is on the shape rather than the list, so a third needs no test change.
	 */
	it("names a boolean setting for every section that has a switch", () => {
		const switched = everyItem().filter((item) => item.feature !== undefined);
		expect(switched.map((item) => item.href)).toEqual(["/statistics", "/variables"]);

		for (const item of switched) {
			const definition = SETTINGS.find((setting) => setting.key === item.feature);
			expect(definition, `${item.href} names a setting that does not exist`).toBeDefined();
			expect(definition?.type, `${item.href}'s switch is not a boolean`).toBe("boolean");
		}
	});

	it("declares a permission this install defines for every section", () => {
		// A section added without deciding who may see it would otherwise be one the sidebar shows to
		// everybody and the page gate has nothing to check.
		for (const item of everyItem()) {
			// A section may name several, meaning any one of them opens it — `/archives` does. Every one
			// still has to be a permission this install defines, and an empty list would be a section
			// nobody can open, so both are checked here rather than only the single-permission form.
			const named = Array.isArray(item.permission) ? item.permission : [item.permission];
			expect(named.length, `${item.href} names no permission at all`).toBeGreaterThan(0);
			for (const permission of named) {
				expect(PANEL_PERMISSION_IDS, `${item.href} names an unknown permission`).toContain(permission);
			}
		}
	});
});
