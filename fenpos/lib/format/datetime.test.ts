import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { formatDate, formatDateTime, resetFormatting, setFormatting } from "@/lib/format/datetime";
import { applyPushedSettings, clearSetting } from "@/lib/settings/settings-service";

/**
 * Tests for `formatDate`/`formatDateTime` and the push pair (`setFormatting`/`resetFormatting`)
 * that `applyPushedSettings` (`settings-service.ts`) drives.
 *
 * The test that matters most is "rebuilds the formatters rather than reusing stale ones": an
 * `Intl.DateTimeFormat` fixes its behaviour at construction, so a `setFormatting` that only
 * recorded new options without rebuilding `DATE_TIME`/`DATE` would pass every other test here
 * while silently going on formatting with whatever was built first.
 */
describe("formatDate / formatDateTime", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
	});

	afterEach(() => {
		// setFormatting mutates this module's shared state; restore its built-in so a value one
		// test pushed cannot leak into the next.
		resetFormatting();
	});

	it("formats in the configured locale", () => {
		setFormatting({ locale: "fi-FI", hour12: false });
		expect(formatDate(new Date("2026-08-22T10:00:00Z"))).toMatch(/22\.8\.2026/);
	});

	it("honours a 24-hour clock", () => {
		setFormatting({ locale: "en-US", hour12: false });
		expect(formatDateTime(new Date("2026-08-22T22:00:00Z"))).not.toMatch(/PM/i);
	});

	it("returns to the built-in formatting when nothing is stored", async () => {
		setFormatting({ locale: "fi-FI", hour12: false });
		await clearSetting("panel.locale");
		await applyPushedSettings();

		expect(formatDate(new Date("2026-08-22T10:00:00Z"))).toMatch(/8\/22\/2026/);
	});

	it("rebuilds the formatters rather than reusing stale ones", () => {
		const before = formatDate(new Date("2026-08-22T10:00:00Z"));
		setFormatting({ locale: "de-DE", hour12: false });
		expect(formatDate(new Date("2026-08-22T10:00:00Z"))).not.toBe(before);
	});

	/**
	 * A literal formatted string is brittle across machines — it would pin whatever offset the
	 * machine running the suite happens to be in. Asserting the *difference* between two fixed,
	 * DST-free zones (Tokyo is UTC+9 year-round) is not: it holds wherever the suite runs.
	 */
	it("applies an explicit time zone rather than the ambient one", () => {
		const instant = new Date("2026-08-22T10:00:00Z");
		const hourIn = (timeZone: string): number => {
			setFormatting({ locale: "en-US", hour12: false, timeZone });
			const match = /(\d{1,2}):\d{2}:\d{2}/.exec(formatDateTime(instant));
			if (!match) {
				throw new Error("expected a formatted time");
			}
			return Number(match[1]);
		};

		expect((hourIn("Asia/Tokyo") - hourIn("UTC") + 24) % 24).toBe(9);
	});
});
