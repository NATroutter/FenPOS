import { describe, expect, it } from "vitest";
import { PANEL_PERMISSION_IDS } from "@/lib/domain/panel-permissions";
import { NAV_GROUPS } from "@/lib/navigation";

/**
 * The permission and navigation half of the Statistics page shell (Task 12).
 *
 * Everything the page itself does — resolving the range, reading the settings, rendering a
 * placeholder per tab — is exercised by the modules it calls (`lib/metrics/range.ts`,
 * `lib/settings/settings-service.ts`) and by the existing permission/navigation invariant tests
 * (`test/lib/domain/panel-permissions.test.ts`, `test/lib/navigation.test.ts`), which already fail
 * if `stats:read` were ungrouped or `/statistics` named a permission this install does not define.
 * These two are the ones the brief calls out by name: the identifier exists, and the sidebar offers
 * a way to it.
 */
describe("the Statistics page's permission and navigation entry", () => {
	it("declares stats:read as a grantable permission", () => {
		expect(PANEL_PERMISSION_IDS).toContain("stats:read");
	});

	it("lists /statistics in the sidebar, gated on stats:read", () => {
		const item = NAV_GROUPS.flatMap((group) => group.items).find((entry) => entry.href === "/statistics");

		expect(item).toBeDefined();
		expect(item?.permission).toBe("stats:read");
	});
});
