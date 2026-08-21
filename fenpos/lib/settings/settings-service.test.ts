import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { JOB_LIMITS } from "@/lib/link/protocol";

import {
	clearSetting,
	DEFAULT_LIMITS,
	globalJobSettings,
	globalLimits,
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
		expect(definition?.max).toBe(JOB_LIMITS.maxLines);
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
