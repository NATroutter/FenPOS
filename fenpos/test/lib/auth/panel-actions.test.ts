import { describe, expect, it } from "vitest";
import { PANEL_ACTIONS, panelActionEntry, registryEntryFor } from "@/lib/auth/panel-actions";
import { PANEL_PERMISSION_IDS } from "@/lib/domain/panel-permissions";

/**
 * The registry every panel action is gated through.
 *
 * The filesystem half — that no action is missing — is `registry-coverage.test.ts`. What is checked
 * here is that the registry is internally coherent: no two entries claiming one id, no entry naming
 * a permission this install does not define, and no gated entry without one.
 */
describe("panel action registry", () => {
	it("names each action once", () => {
		const ids = PANEL_ACTIONS.map((entry) => entry.id);

		expect(new Set(ids).size).toBe(ids.length);
	});

	it("points every gated entry at a permission that exists", () => {
		for (const entry of PANEL_ACTIONS) {
			if (entry.kind === "command" || entry.kind === "query") {
				expect(entry.permission).not.toBeNull();
				expect(PANEL_PERMISSION_IDS).toContain(entry.permission);
			}
		}
	});

	it("leaves no permission on an entry that checks none", () => {
		for (const entry of PANEL_ACTIONS) {
			if (entry.kind === "self" || entry.kind === "unauthenticated" || entry.kind === "custom") {
				// A permission here would read as a check that nothing performs.
				expect(entry.permission).toBeNull();
			}
		}
	});

	/**
	 * Every id equals its permission, unless it is one of the pairs below.
	 *
	 * This is the check `permission-matrix.test.ts` cannot make. That test grants whatever an entry
	 * names and then asserts the gate lets the caller through, which is self-consistent: an entry
	 * pointing at the wrong permission passes it just as happily as a right one. Nothing else in the
	 * suite says what the right one is.
	 *
	 * So the convention is asserted instead, and the exceptions are enumerated. Each is a case where
	 * two exports deliberately share one permission and keep separate ids, because a row that says
	 * which of them ran is worth more than one that cannot tell them apart. Adding an entry that
	 * breaks the convention means adding it here, with a reason — which is the point.
	 */
	const SHARED_PERMISSIONS: Record<string, string> = {
		// Two ways to replace an image's bytes: from an upload, and from a URL.
		"assets:replace-from-url": "assets:replace",
		// Listing images and listing variables are both reads of the Tools page's own data.
		"tools:list-images": "tools:read",
		"tools:list-variables": "tools:read",
		// One session or all of them.
		"users:revoke-session": "users:revoke-sessions",
		// Roles and individual grants are both `users:grant`.
		"users:set-roles": "users:grant",
		"users:set-permissions": "users:grant",
		// Setting or removing another account's picture is `users:update` too: the same permission that
		// governs its name and email, not a permission of its own — see the registry's own note on
		// `users:set-avatar`.
		"users:set-avatar": "users:update",
		"users:remove-avatar": "users:update",
		// Reading an account's sessions is part of reading the account.
		"users:list-sessions": "users:read",
		// Being pointed at the archived month a filtered range reaches into is part of reading the
		// record: it says a period of the audit history exists and where it went, which is exactly what
		// `audit:read` governs. A permission of its own would gate the signpost separately from the table
		// it stands beside, so a reader could be shown an empty range and not told why.
		"audit:archive-covering": "audit:read",
	};

	it("gives every gated entry the permission its id names, or a documented shared one", () => {
		for (const entry of PANEL_ACTIONS) {
			if (entry.kind !== "command" && entry.kind !== "query") {
				continue;
			}
			expect(entry.permission, `${entry.id} points at an undocumented permission`).toBe(
				SHARED_PERMISSIONS[entry.id] ?? entry.id,
			);
		}
	});

	it("names each module-and-export pair once", () => {
		const pairs = PANEL_ACTIONS.map((entry) => `${entry.module}#${entry.exportName}`);

		expect(new Set(pairs).size).toBe(pairs.length);
	});

	it("finds an entry by its id", () => {
		expect(panelActionEntry("devices:delete").permission).toBe("devices:delete");
	});

	it("throws for an id it does not know, rather than returning a permissive default", () => {
		// The failure this avoids: a typo'd id resolving to an entry that gates nothing.
		expect(() => panelActionEntry("devices:vanish" as never)).toThrow();
	});

	it("finds an entry by the file and export it belongs to", () => {
		expect(registryEntryFor("(panel)/agents/actions.ts", "deleteAgent")?.id).toBe("agents:delete");
	});

	it("gives every entry a description that is not the id", () => {
		for (const entry of PANEL_ACTIONS) {
			expect(entry.description.length).toBeGreaterThan(10);
			expect(entry.description).not.toBe(entry.id);
		}
	});
});
