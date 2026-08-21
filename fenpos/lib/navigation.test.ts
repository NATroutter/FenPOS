import { describe, expect, it } from "vitest";
import { findNavItem, NAV_GROUPS, NAV_ITEMS, type NavItem } from "@/lib/navigation";

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
});
