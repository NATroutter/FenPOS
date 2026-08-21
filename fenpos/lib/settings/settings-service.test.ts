import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import type { LogLevel } from "@/lib/domain/enums";
import { isProduction } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { JOB_LIMITS } from "@/lib/link/protocol";
import { logger, setMinimumLevel } from "@/lib/logger";

import type { SettingKey, SettingType } from "@/lib/settings/settings-service";
import {
	applyPushedSettings,
	booleanSetting,
	CATEGORIES,
	clearSetting,
	DEFAULT_LIMITS,
	enumSetting,
	globalJobSettings,
	globalLimits,
	integerSetting,
	listSettings,
	SETTING_KEYS,
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

	it("declares the type every setting is documented to have", () => {
		// A key→type map rather than a blanket "every setting is an integer" (which stopped being
		// true the moment `logs.minimumLevel`, the first enum, joined them): this must fail if ANY
		// setting's declared `type` changes, and it must fail if a key is added to `SETTING_KEYS`
		// without an entry here. `fits()` rejecting a bad value is a side effect of the behavioural
		// tests, not a check on the declared type itself — this is that check.
		const expectedTypes: Record<SettingKey, SettingType> = {
			"limits.maxLines": "integer",
			"limits.maxLineChars": "integer",
			"limits.maxTotalChars": "integer",
			"limits.maxOutputLines": "integer",
			"jobs.retentionMinutes": "integer",
			"jobs.maxRecords": "integer",
			"jobs.shutdownGraceSeconds": "integer",
			"logs.minimumLevel": "enum",
		};

		// Catches a key missing from the map above (as well as one present here but no longer in
		// SETTING_KEYS), independently of the per-definition loop below.
		expect(Object.keys(expectedTypes).sort()).toEqual([...SETTING_KEYS].sort());

		for (const definition of SETTINGS) {
			expect(definition.type, definition.key).toBe(expectedTypes[definition.key]);
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
 * exercised this way today; no boolean or string setting exists yet, and a test key added to
 * `SETTING_KEYS` for the occasion would be a stored contract nobody else asked for. `logs.minimumLevel`
 * (Task 9) gives the enum variant its real coverage below; Task 10 adds the first string setting.
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

/**
 * `logs.minimumLevel` — the first enum setting, and the one that pushes into the logger.
 *
 * The "stored as JSON" test below is the one that actually proves the write path: for an integer,
 * `String(250) === JSON.stringify(250)`, so the existing integer coverage cannot tell `JSON.stringify`
 * and a `String(value)` regression apart. A string value can: `String("INFO")` is `INFO`, unquoted,
 * while `JSON.stringify("INFO")` is `"INFO"`, with the quotes — and only the quoted form round-trips
 * through `parseStored`'s `JSON.parse`.
 */
describe("logs.minimumLevel", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
	});

	afterEach(() => {
		// applyPushedSettings mutates the logger's shared module state; restore its built-in
		// default so a level this describe block set cannot leak into an unrelated test.
		setMinimumLevel(isProduction ? "INFO" : "DEBUG");
	});

	it("pushes the log level into the logger when it changes", async () => {
		await setSetting("logs.minimumLevel", "DEBUG");
		await applyPushedSettings();
		expect(await enumSetting<LogLevel>("logs.minimumLevel")).toBe("DEBUG");
	});

	it("refuses a level that is not a known severity", async () => {
		await expect(setSetting("logs.minimumLevel", "TRACE")).rejects.toThrow(ApiError);
	});

	it("actually changes what the logger writes, not just what is stored", async () => {
		// The test above confirms the value round-trips; this one confirms setSetting's own
		// `applyPushedSettings()` call (settings-service.ts) really reaches the logger's mutable
		// level, by observing its effect on `process.stdout.write` rather than on the store.
		await setSetting("logs.minimumLevel", "ERROR");

		const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			logger.warn("should be dropped now that the minimum level is ERROR");
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("stores the level as quoted JSON, not as bare text", async () => {
		// The regression this guards against: a write path that reverted to `String(value)` would
		// store `INFO` with no quotes, which is not valid JSON, so the next read would fail to
		// parse it and the setting would silently revert to its default.
		await setSetting("logs.minimumLevel", "INFO");
		const row = await prisma.setting.findUnique({ where: { key: "logs.minimumLevel" } });
		expect(row?.value).toBe(JSON.stringify("INFO"));
		expect(row?.value).toBe('"INFO"');
	});
});
