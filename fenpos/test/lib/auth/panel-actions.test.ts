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
