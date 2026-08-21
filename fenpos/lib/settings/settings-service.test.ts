import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { JOB_LIMITS } from "@/lib/link/protocol";

import {
	booleanSetting,
	CATEGORIES,
	clearSetting,
	DEFAULT_LIMITS,
	globalJobSettings,
	globalLimits,
	integerSetting,
	listSettings,
	SETTINGS,
	setSetting,
} from "@/lib/settings/settings-service";

/**
 * Tests for install-wide settings.
 *
 * The behaviour worth pinning down is what happens when nothing is stored. A key with no row
 * means "use the built-in default", so the defaults stay in code where they can be read — and an
 * upgrade that improves one improves it for everyone who never touched it.
 */
describe("settings", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
	});

	const valueOf = async (key: string): Promise<number> => {
		const settings = await listSettings();
		const found = settings.find((setting) => setting.definition.key === key);
		if (!found) {
			throw new Error(`no setting ${key}`);
		}
		// Every key this helper is called with names an integer setting today.
		if (typeof found.value !== "number") {
			throw new Error(`setting ${key} is not an integer setting`);
		}
		return found.value;
	};

	it("reports the built-in default when nothing is stored", async () => {
		const settings = await listSettings();

		for (const setting of settings) {
			expect(setting.value).toBe(setting.definition.fallback);
			expect(setting.overridden).toBe(false);
		}
	});

	it("stores and reports an override", async () => {
		await setSetting("limits.maxLines", 42);

		const settings = await listSettings();
		const maxLines = settings.find((setting) => setting.definition.key === "limits.maxLines");

		expect(maxLines?.value).toBe(42);
		expect(maxLines?.overridden).toBe(true);
	});

	it("returns a setting to its default when cleared", async () => {
		await setSetting("limits.maxLines", 42);

		await clearSetting("limits.maxLines");

		expect(await valueOf("limits.maxLines")).toBe(DEFAULT_LIMITS.maxLines);
	});

	it("refuses an unknown key", async () => {
		await expect(setSetting("limits.nonsense", 1)).rejects.toBeInstanceOf(ApiError);
	});

	it("refuses a value outside its range", async () => {
		await expect(setSetting("jobs.shutdownGraceSeconds", 0)).rejects.toBeInstanceOf(ApiError);
		await expect(setSetting("jobs.shutdownGraceSeconds", 10_000)).rejects.toBeInstanceOf(ApiError);
	});

	it("refuses a value that is not a whole number", async () => {
		await expect(setSetting("limits.maxLines", 1.5)).rejects.toBeInstanceOf(ApiError);
	});

	it("ignores a stored value outside its range rather than clamping it", async () => {
		// It can only have got there by a hand edit or an older version with wider bounds, and
		// quietly applying half of someone's intention is worse than applying none of it.
		await prisma.setting.create({ data: { key: "limits.maxLines", value: "999999999" } });

		const settings = await listSettings();
		const maxLines = settings.find((setting) => setting.definition.key === "limits.maxLines");

		expect(maxLines?.value).toBe(DEFAULT_LIMITS.maxLines);
		expect(maxLines?.overridden).toBe(false);
	});

	it("ignores a stored value that is not a number", async () => {
		await prisma.setting.create({ data: { key: "limits.maxLineChars", value: "lots" } });

		expect(await valueOf("limits.maxLineChars")).toBe(DEFAULT_LIMITS.maxLineChars);
	});

	it("supplies the built-in limits when nothing is stored", async () => {
		expect(await globalLimits()).toEqual(DEFAULT_LIMITS);
	});

	it("supplies stored limits to the print path", async () => {
		await setSetting("limits.maxOutputLines", 7);

		expect((await globalLimits()).maxOutputLines).toBe(7);
	});

	it("reads job settings as one object, honouring overrides", async () => {
		await prisma.setting.create({ data: { key: "jobs.maxRecords", value: "500" } });

		expect(await globalJobSettings()).toEqual({
			retentionMinutes: 1440,
			maxRecords: 500,
			shutdownGraceSeconds: 10,
		});
	});
});

/**
 * Tests for the shape of a setting's definition, independent of any one setting's value.
 *
 * The last test here is the compatibility guarantee and must never be weakened: rows written
 * before values became JSON hold a bare integer (`200`, not `"200"`), and `JSON.parse("200")`
 * returns `200` — which is why this change needs no database migration.
 */
describe("setting definitions", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
	});

	it("gives every setting a category the category table names", () => {
		const known = new Set(CATEGORIES.map((category) => category.id));
		for (const definition of SETTINGS) {
			expect(known).toContain(definition.category);
		}
	});

	it("gives every category at least one setting, so the nav has no dead entries", () => {
		for (const category of CATEGORIES) {
			expect(SETTINGS.some((definition) => definition.category === category.id)).toBe(true);
		}
	});

	it("types every setting that exists today as an integer", () => {
		for (const definition of SETTINGS) {
			expect(definition.type).toBe("integer");
		}
	});

	it("still reads a row stored before values became JSON", async () => {
		await prisma.setting.create({ data: { key: "limits.maxLines", value: "250" } });

		const settings = await listSettings();
		const stored = settings.find((setting) => setting.definition.key === "limits.maxLines");

		expect(stored?.value).toBe(250);
		expect(stored?.overridden).toBe(true);
	});
});

/**
 * `limits.maxOutputLines` must never offer more than the dispatch frame will accept
 * (`JOB_LIMITS.maxLines`) — a higher setting produces jobs that compile and then fail to
 * serialise. Pinned down separately because the bound is derived rather than a literal.
 */
describe("limits.maxOutputLines bounds", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
	});

	it("caps at the frame's line limit rather than restating a number", () => {
		const definition = SETTINGS.find((setting) => setting.key === "limits.maxOutputLines");
		if (definition?.type !== "integer") {
			throw new Error("expected limits.maxOutputLines to be an integer setting");
		}
		expect(definition.max).toBe(JOB_LIMITS.maxLines);
	});

	it("ignores a stored value above the cap, falling back to the default", async () => {
		await prisma.setting.create({
			data: { key: "limits.maxOutputLines", value: String(JOB_LIMITS.maxLines + 1) },
		});

		const settings = await listSettings();
		const stored = settings.find((setting) => setting.definition.key === "limits.maxOutputLines");

		expect(stored?.value).toBe(DEFAULT_LIMITS.maxOutputLines);
		expect(stored?.overridden).toBe(false);
	});

	it("accepts a stored value at exactly the cap", async () => {
		await prisma.setting.create({
			data: { key: "limits.maxOutputLines", value: String(JOB_LIMITS.maxLines) },
		});

		const settings = await listSettings();
		const stored = settings.find((setting) => setting.definition.key === "limits.maxOutputLines");

		expect(stored?.value).toBe(JOB_LIMITS.maxLines);
		expect(stored?.overridden).toBe(true);
	});

	it("refuses a save above the cap", async () => {
		await expect(setSetting("limits.maxOutputLines", JOB_LIMITS.maxLines + 1)).rejects.toThrow(ApiError);
	});
});

/**
 * Exercises `setSetting`'s per-variant validation and the typed accessors, through
 * `limits.maxLines` — an existing `type: "integer"` setting. Only the integer path can be
 * exercised this way today; no boolean, enum or string setting exists yet, and a test key added
 * to `SETTING_KEYS` for the occasion would be a stored contract nobody else asked for. Tasks 9
 * and 10 add the first enum and string settings, which is where those variants get their real
 * coverage.
 */
describe("value variants", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
	});

	it("stores and reads back an integer", async () => {
		await setSetting("limits.maxLines", 250);
		expect(await integerSetting("limits.maxLines")).toBe(250);
	});

	it("refuses a string for an integer setting", async () => {
		await expect(setSetting("limits.maxLines", "250")).rejects.toThrow(ApiError);
	});

	it("refuses a fractional integer", async () => {
		await expect(setSetting("limits.maxLines", 2.5)).rejects.toThrow(ApiError);
	});

	it("refuses an out-of-range integer", async () => {
		await expect(setSetting("limits.maxLines", 0)).rejects.toThrow(ApiError);
	});

	it("refuses an unknown key", async () => {
		await expect(setSetting("limits.notASetting", 1)).rejects.toThrow(ApiError);
	});

	it("throws when an accessor is pointed at another variant", async () => {
		await expect(booleanSetting("limits.maxLines")).rejects.toThrow();
	});

	it("stores an integer as JSON, not as bare text", async () => {
		await setSetting("limits.maxLines", 250);
		const row = await prisma.setting.findUnique({ where: { key: "limits.maxLines" } });
		expect(row?.value).toBe("250");
	});
});
