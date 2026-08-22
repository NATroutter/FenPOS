import { describe, expect, it } from "vitest";
import { dashboardStatLabel } from "@/app/(panel)/dashboard/prose";

/**
 * Boundary tests for the Dashboard's headline labels, at `panel.dashboardWindowHours`'s declared
 * `min` and `max` (`settings-service.ts`), and at the setting's fallback — mirroring
 * `sessionLifetimePhrase`'s tests (`lib/auth/session.test.ts`) and `signInThrottlePhrase`'s
 * (`lib/auth/rate-limit.test.ts`).
 */
describe("dashboardStatLabel", () => {
	it("names the setting's minimum", () => {
		expect(dashboardStatLabel("Printed", 1)).toBe("Printed (1h)");
		expect(dashboardStatLabel("Failed", 1)).toBe("Failed (1h)");
	});

	it("names the setting's fallback", () => {
		expect(dashboardStatLabel("Printed", 24)).toBe("Printed (24h)");
		expect(dashboardStatLabel("Failed", 24)).toBe("Failed (24h)");
	});

	it("names the setting's maximum", () => {
		expect(dashboardStatLabel("Printed", 720)).toBe("Printed (720h)");
		expect(dashboardStatLabel("Failed", 720)).toBe("Failed (720h)");
	});
});
