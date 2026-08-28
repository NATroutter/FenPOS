import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MINIMUM_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { prisma } from "@/lib/db";
import type { LogLevel } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";
import { resetFormatting } from "@/lib/format/datetime";
import { agentSettingsSchema, JOB_LIMITS, jobSettingsSchema, rawWriteSchema } from "@/lib/link/protocol";
import { logger, resetMinimumLevel } from "@/lib/logger";

import type { SettingKey, SettingType } from "@/lib/settings/settings-service";
import {
	applyPushedSettings,
	booleanSetting,
	CATEGORIES,
	clearSetting,
	DEFAULT_LIMITS,
	enumSetting,
	globalAgentSettings,
	globalJobSettings,
	globalLimits,
	globalLogIngestSettings,
	globalPasswordLifetime,
	globalPasswordPolicy,
	globalSessionPolicy,
	globalSignInPolicy,
	integerSetting,
	listSettings,
	SETTING_KEYS,
	SETTINGS,
	setSetting,
	stringSetting,
	toClientDefinition,
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

	it("reads agent timing settings as one object, honouring overrides", async () => {
		await prisma.setting.create({ data: { key: "agent.queuePollMs", value: "250" } });

		expect(await globalAgentSettings()).toEqual({
			statusIntervalSeconds: 30,
			evictionIntervalSeconds: 60,
			queuePollMs: 250,
		});
	});

	it("reads log ingestion settings as one object, honouring overrides", async () => {
		await prisma.setting.create({ data: { key: "logs.retentionDays", value: "5" } });

		expect(await globalLogIngestSettings()).toEqual({
			linesPerMinutePerAgent: 120,
			retentionDays: 5,
			archiveEnabled: true,
			archiveRetentionDays: 365,
			maxMessageChars: 1000,
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

	/**
	 * Pins down the rail's order (spec §3), which drifted once already: each earlier task inserted
	 * its category relative to the previous one, but `logs` was already present, so every
	 * insertion landed in front of it rather than where the spec puts it.
	 */
	it("lists categories in the order the spec's §3 table specifies", () => {
		expect(CATEGORIES.map((category) => category.id)).toEqual([
			"general",
			"limits",
			"jobs",
			"logs",
			"media",
			"variables",
			"security",
			"audit",
			"connections",
			"panel",
		]);
	});

	it("requires nothing of a password but its length", async () => {
		// Composition rules push people toward `Password1!` and away from the long passphrases that are
		// actually stronger. They exist for installs that answer to a policy demanding them.
		const policy = await globalPasswordPolicy();

		expect(policy.minimumLength).toBe(MINIMUM_PASSWORD_LENGTH);
		expect(policy.requireMixedCase).toBe(false);
		expect(policy.requireDigit).toBe(false);
		expect(policy.requireSymbol).toBe(false);
	});

	it("locks nobody out and restricts no address by default", async () => {
		// A lockout is a denial-of-service primitive handed to anyone who knows an email address, and a
		// misconfigured allowlist locks every administrator out of a LAN appliance with no offline
		// remedy until phase 8.
		const policy = await globalSignInPolicy();

		expect(policy.lockoutAfterFailures).toBe(0);
		expect(policy.ipAllowlist).toBe("");
	});

	it("expires no password and remembers none by default", async () => {
		const lifetime = await globalPasswordLifetime();

		expect(lifetime.expiryDays).toBe(0);
		expect(lifetime.reuseCount).toBe(0);
	});

	it("honours an override on each of the three readers", async () => {
		await setSetting("auth.requireDigit", true);
		await setSetting("auth.lockoutAfterFailures", 5);
		await setSetting("auth.passwordReuseCount", 3);

		expect((await globalPasswordPolicy()).requireDigit).toBe(true);
		expect((await globalSignInPolicy()).lockoutAfterFailures).toBe(5);
		expect((await globalPasswordLifetime()).reuseCount).toBe(3);
	});

	it("never lets a stored minimum fall below the built-in floor", async () => {
		// `setSetting`'s own `min` refuses this on write; the floor here is what protects against a row
		// written before that bound existed, or edited around it.
		await prisma.setting.create({
			data: { key: "auth.minimumPasswordLength", value: JSON.stringify(4) },
		});

		expect((await globalPasswordPolicy()).minimumLength).toBe(MINIMUM_PASSWORD_LENGTH);
	});

	it("defaults page-view recording to off", async () => {
		// Not the reading the spec's phrasing implies, and deliberately so. `router.refresh()` re-runs a
		// route's server component, so a live tab produces page views at event rate rather than at
		// navigation rate — and every audit append serialises on `prev_hash`'s unique constraint with
		// five retries. On by default would make real actions lose that race to page views.
		expect(await booleanSetting("audit.recordPageViews")).toBe(false);
	});

	it("declares the type every setting is documented to have", () => {
		// A key→type map rather than a blanket "every setting is an integer" (which stopped being
		// true the moment `logs.minimumLevel`, the first enum, joined them): this must fail if ANY
		// setting's declared `type` changes, and it must fail if a key is added to `SETTING_KEYS`
		// without an entry here. `fits()` rejecting a bad value is a side effect of the behavioural
		// tests, not a check on the declared type itself — this is that check.
		const expectedTypes: Record<SettingKey, SettingType> = {
			"server.publicUrl": "string",
			"limits.maxLines": "integer",
			"limits.maxLineChars": "integer",
			"limits.maxTotalChars": "integer",
			"limits.maxOutputLines": "integer",
			"jobs.retentionMinutes": "integer",
			"jobs.maxRecords": "integer",
			"jobs.shutdownGraceSeconds": "integer",
			"jobs.maxErrorMessageChars": "integer",
			"assets.maxUploadMb": "integer",
			"assets.acceptedFormats": "enum",
			"assets.rasterCacheMb": "integer",
			"images.maxRemoteReferences": "integer",
			"images.remoteFetchTimeoutMs": "integer",
			"images.allowPlainHttp": "boolean",
			"images.allowedRemoteHosts": "string",
			"variables.enabled": "boolean",
			"variables.allowRequestValues": "boolean",
			"variables.maxCount": "integer",
			"variables.maxValueChars": "integer",
			"variables.maxPerRequest": "integer",
			"variables.maxPerElement": "integer",
			"variables.timezone": "enum",
			"variables.locale": "enum",
			"logs.minimumLevel": "enum",
			"logs.linesPerMinutePerAgent": "integer",
			"logs.retentionDays": "integer",
			"logs.archiveEnabled": "boolean",
			"logs.archiveRetentionDays": "integer",
			"logs.maxMessageChars": "integer",
			"logs.recordApiReads": "boolean",
			"pairing.enabled": "boolean",
			"pairing.codeMinutes": "integer",
			"auth.sessionHours": "integer",
			"auth.signInAttemptsPerMinute": "integer",
			"auth.minimumPasswordLength": "integer",
			"auth.lastSeenRefreshMinutes": "integer",
			"auth.requireMixedCase": "boolean",
			"auth.requireDigit": "boolean",
			"auth.requireSymbol": "boolean",
			"auth.passwordReuseCount": "integer",
			"auth.passwordExpiryDays": "integer",
			"auth.lockoutAfterFailures": "integer",
			"auth.lockoutMinutes": "integer",
			"auth.ipAllowlist": "string",
			"auth.require2fa": "boolean",
			"auth.idleTimeoutMinutes": "integer",
			"auth.maxConcurrentSessions": "integer",
			"audit.retentionDays": "integer",
			"audit.recordPageViews": "boolean",
			"api.readsPerMinute": "integer",
			"api.defaultPageSize": "integer",
			"api.maxPageSize": "integer",
			"webhooks.enabled": "boolean",
			"webhooks.allowPlainHttp": "boolean",
			"webhooks.timeoutMs": "integer",
			"webhooks.maxAttempts": "integer",
			"webhooks.retryBackoffSeconds": "integer",
			"webhooks.maxDeliveryRecords": "integer",
			"webhooks.deliverySweepEvery": "integer",
			"events.keepaliveSeconds": "integer",
			"link.heartbeatSeconds": "integer",
			"link.heartbeatTimeoutSeconds": "integer",
			"link.handshakeTimeoutSeconds": "integer",
			"link.commandTimeoutSeconds": "integer",
			"link.scanTimeoutSeconds": "integer",
			"link.statusIntervalSeconds": "integer",
			"link.allowRawApiWrites": "boolean",
			"link.maxRawWriteBytes": "integer",
			"agent.evictionIntervalSeconds": "integer",
			"agent.queuePollMs": "integer",
			"panel.jobPageSize": "integer",
			"panel.logPageSize": "integer",
			"panel.dashboardWindowHours": "integer",
			"panel.dashboardTailLines": "integer",
			"panel.locale": "enum",
			"panel.timeFormat": "enum",
			"panel.timezone": "enum",
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

	describe("globalSessionPolicy", () => {
		it("returns the fallbacks as milliseconds and seconds", async () => {
			const policy = await globalSessionPolicy();
			expect(policy.sessionSeconds).toBe(12 * 60 * 60);
			expect(policy.idleTimeoutMs).toBe(0);
			expect(policy.lastSeenRefreshMs).toBe(5 * 60 * 1000);
			expect(policy.maxConcurrentSessions).toBe(0);
		});

		it("converts a stored idle timeout from minutes", async () => {
			await setSetting("auth.idleTimeoutMinutes", 30);
			expect((await globalSessionPolicy()).idleTimeoutMs).toBe(30 * 60 * 1000);
		});

		it("converts a stored session lifetime from hours", async () => {
			await setSetting("auth.sessionHours", 4);
			expect((await globalSessionPolicy()).sessionSeconds).toBe(4 * 60 * 60);
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
 * exercised this way today; no boolean setting exists yet, and a test key added to
 * `SETTING_KEYS` for the occasion would be a stored contract nobody else asked for.
 * `logs.minimumLevel` gives the enum variant its real coverage below; `server.publicUrl` does the
 * same for the string variant.
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
		resetMinimumLevel();
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

	it("resets the logger to its own built-in level when cleared, not to the fallback", async () => {
		// The setting's `fallback` is "INFO" — what the panel shows as "default" — but the logger's
		// own built-in outside production is "DEBUG" (logger.ts). Clearing an override must restore
		// the built-in, not push the fallback: pushing "INFO" here is exactly what used to drop a
		// fresh install's dev server from DEBUG to INFO the moment startup ran applyPushedSettings.
		await setSetting("logs.minimumLevel", "ERROR");
		await clearSetting("logs.minimumLevel");

		const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			logger.debug("written only once the logger is back at its DEBUG built-in");
			expect(spy).toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});

/**
 * `server.publicUrl` — the first string setting, and the first with a `pattern`.
 *
 * The empty string is a real, meaningful value here rather than "unset": it means "derive the
 * address from the request", which is what an install that has never touched this setting does.
 * That is why it must fit the pattern rather than be refused by it, and why it is the fallback.
 */
describe("server.publicUrl", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
	});

	it("defaults to the empty string, meaning derive from the request", async () => {
		expect(await stringSetting("server.publicUrl")).toBe("");
	});

	it("stores and reads back an absolute URL", async () => {
		await setSetting("server.publicUrl", "https://fenpos.example.com");
		expect(await stringSetting("server.publicUrl")).toBe("https://fenpos.example.com");
	});

	it("accepts the empty string", async () => {
		await setSetting("server.publicUrl", "https://fenpos.example.com");
		await setSetting("server.publicUrl", "");
		expect(await stringSetting("server.publicUrl")).toBe("");
	});

	it("refuses a value with no scheme", async () => {
		await expect(setSetting("server.publicUrl", "fenpos.example.com")).rejects.toThrow(ApiError);
	});

	it("refuses a scheme other than http or https", async () => {
		await expect(setSetting("server.publicUrl", "ftp://fenpos.example.com")).rejects.toThrow(ApiError);
	});

	it("refuses a value longer than the declared maximum", async () => {
		const definition = SETTINGS.find((setting) => setting.key === "server.publicUrl");
		if (definition?.type !== "string") {
			throw new Error("expected server.publicUrl to be a string setting");
		}
		const tooLong = `https://${"a".repeat(definition.maxLength)}.example.com`;
		await expect(setSetting("server.publicUrl", tooLong)).rejects.toThrow(ApiError);
	});

	it("throws when an accessor is pointed at another variant", async () => {
		await expect(integerSetting("server.publicUrl")).rejects.toThrow();
	});

	it("stores the address as quoted JSON, not as bare text", async () => {
		// The regression this guards against is the same as logs.minimumLevel's: a write path that
		// reverted to `String(value)` would store the URL unquoted, which is not valid JSON, so the
		// next read would fail to parse it and the setting would silently revert to its default.
		await setSetting("server.publicUrl", "https://fenpos.example.com");
		const row = await prisma.setting.findUnique({ where: { key: "server.publicUrl" } });
		expect(row?.value).toBe(JSON.stringify("https://fenpos.example.com"));
		expect(row?.value).toBe('"https://fenpos.example.com"');
	});
});

/**
 * `auth.signInAttemptsPerMinute` and `auth.minimumPasswordLength` are safe to expose as settings
 * only because their declared range cannot cross the built-in value in the direction that would
 * weaken security. For password length, higher is stronger, so the declared `min` (12) equals the
 * built-in floor — it can only be raised. For sign-in attempts, lower is stronger, so the declared
 * `max` (5) equals the built-in ceiling — it can only be lowered. These tests enforce that: neither
 * bound may ever move past the built-in value toward the weaker direction.
 */
describe("security setting bounds", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
	});

	it("refuses to loosen the sign-in throttle above the built-in ceiling", async () => {
		await expect(setSetting("auth.signInAttemptsPerMinute", 6)).rejects.toThrow(ApiError);
	});

	it("refuses to weaken the minimum password length below the built-in floor", async () => {
		await expect(setSetting("auth.minimumPasswordLength", 11)).rejects.toThrow(ApiError);
	});

	it("accepts a value at exactly the built-in bound", async () => {
		await setSetting("auth.signInAttemptsPerMinute", 5);
		expect(await integerSetting("auth.signInAttemptsPerMinute")).toBe(5);

		await setSetting("auth.minimumPasswordLength", 12);
		expect(await integerSetting("auth.minimumPasswordLength")).toBe(12);
	});

	it("accepts a value tightened past the built-in bound", async () => {
		await setSetting("auth.signInAttemptsPerMinute", 3);
		expect(await integerSetting("auth.signInAttemptsPerMinute")).toBe(3);

		await setSetting("auth.minimumPasswordLength", 24);
		expect(await integerSetting("auth.minimumPasswordLength")).toBe(24);
	});
});

/**
 * `toClientDefinition` is the only runtime guard against a render-time crash: `pattern` is a
 * `RegExp`, and a `RegExp` cannot cross React's server→client boundary. The function only strips
 * it from the `string` variant — `type !== "string"` returns the definition untouched — so a
 * `RegExp`, `Date`, or function added to the `integer`, `boolean` or `enum` variant would pass
 * straight through with no compile error, since TypeScript types are erased at runtime.
 *
 * A JSON round trip is what actually catches that: `JSON.stringify` turns a `RegExp` into `{}`,
 * so a client definition carrying one no longer equals its own round trip. `structuredClone` would
 * not do this — it clones a `RegExp` faithfully, so a definition that leaked one would still equal
 * its clone and this test would pass regardless.
 */
describe("toClientDefinition", () => {
	it("produces a definition that survives a JSON round trip unchanged, for every setting", () => {
		for (const definition of SETTINGS) {
			const clientDefinition = toClientDefinition(definition);
			expect(clientDefinition, definition.key).toEqual(JSON.parse(JSON.stringify(clientDefinition)));
		}
	});
});

/**
 * `jobs.retentionMinutes`, `jobs.maxRecords` and `jobs.shutdownGraceSeconds` derive their bounds
 * from `jobSettingsSchema` (`lib/link/protocol.ts`) rather than restating them, for the same
 * reason `limits.maxOutputLines` derives from `JOB_LIMITS.maxLines`: a bound widened in `SETTINGS`
 * without a matching widening in the wire schema is a setting the panel accepts that
 * `serialiseServerFrame` then refuses, which `pushDeviceConfig` only catches and logs — the agent
 * silently never receives the change.
 */
describe("jobs.* bounds", () => {
	it("match jobSettingsSchema's own declared bounds", () => {
		const cases: readonly [SettingKey, "retentionMinutes" | "maxRecords" | "shutdownGraceSeconds"][] = [
			["jobs.retentionMinutes", "retentionMinutes"],
			["jobs.maxRecords", "maxRecords"],
			["jobs.shutdownGraceSeconds", "shutdownGraceSeconds"],
		];

		for (const [settingKey, schemaField] of cases) {
			const definition = SETTINGS.find((setting) => setting.key === settingKey);
			if (definition?.type !== "integer") {
				throw new Error(`expected ${settingKey} to be an integer setting`);
			}
			const field = jobSettingsSchema.shape[schemaField];
			expect(definition.min, settingKey).toBe(field.minValue);
			expect(definition.max, settingKey).toBe(field.maxValue);
		}
	});
});

/**
 * `link.statusIntervalSeconds`, `agent.evictionIntervalSeconds` and `agent.queuePollMs` derive
 * their bounds from `agentSettingsSchema` (`lib/link/protocol.ts`) for the same reason `jobs.*`
 * derives from `jobSettingsSchema`, above: a bound widened in `SETTINGS` without a matching
 * widening in the wire schema is a setting the panel accepts that `serialiseServerFrame` then
 * refuses, which `pushDeviceConfig` only catches and logs — the agent silently never receives the
 * change.
 */
describe("agent.* bounds", () => {
	it("match agentSettingsSchema's own declared bounds", () => {
		const cases: readonly [SettingKey, "statusIntervalSeconds" | "evictionIntervalSeconds" | "queuePollMs"][] = [
			["link.statusIntervalSeconds", "statusIntervalSeconds"],
			["agent.evictionIntervalSeconds", "evictionIntervalSeconds"],
			["agent.queuePollMs", "queuePollMs"],
		];

		for (const [settingKey, schemaField] of cases) {
			const definition = SETTINGS.find((setting) => setting.key === settingKey);
			if (definition?.type !== "integer") {
				throw new Error(`expected ${settingKey} to be an integer setting`);
			}
			const field = agentSettingsSchema.shape[schemaField];
			expect(definition.min, settingKey).toBe(field.minValue);
			expect(definition.max, settingKey).toBe(field.maxValue);
		}
	});
});

/**
 * `assets.maxUploadMb`'s ceiling and `next.config.ts`'s server-action body limit are two numbers
 * that have to agree, and nothing in the type system connects them: the setting is validated in
 * `settings-service.ts`, the framework limit lives in a config file neither imports, and an
 * operator who raises the setting past the framework's own ceiling would be told no by Next
 * itself — a page with no wording this project chose, for a number nobody could find. This is
 * what notices if the two drift: it fails the moment someone widens the setting's `max` without
 * widening `bodySizeLimit` to stay above it.
 *
 * Both numbers are MiB-scale here — `assets.maxUploadMb`'s own unit, and `next.config.ts`'s
 * `"Nmb"` string, which this project's convention (and Next's own `bytes` dependency) treats as
 * 1024-based — so the comparison below is a direct one, with no unit conversion between them.
 */
describe("assets.maxUploadMb's ceiling", () => {
	it("keeps the framework body ceiling above the setting's maximum", () => {
		const definition = SETTINGS.find((setting) => setting.key === "assets.maxUploadMb");
		if (definition?.type !== "integer") {
			throw new Error("assets.maxUploadMb must be an integer setting.");
		}

		const config = readFileSync("next.config.ts", "utf8");
		const ceiling = /bodySizeLimit:\s*"(\d+)mb"/i.exec(config);

		expect(ceiling).not.toBeNull();
		expect(Number(ceiling?.[1])).toBeGreaterThan(definition.max);
	});
});

/**
 * `panel.locale`, `panel.timeFormat` and `panel.timezone` — the second group of settings pushed
 * into a module's mutable state rather than read where used, alongside `logs.minimumLevel`. The
 * behaviour of the push itself (locale, clock, rebuilt formatters) belongs to `datetime.test.ts`;
 * what belongs here is validation at the store's boundary and the raw text each writes, since all
 * three are non-integer and so are the only settings that can actually prove `setSetting` writes
 * JSON rather than `String(value)` — see `logs.minimumLevel`'s equivalent test above for why an
 * integer cannot tell the two apart.
 */
describe("panel.locale, panel.timeFormat, panel.timezone", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
	});

	afterEach(() => {
		// applyPushedSettings mutates datetime.ts's shared module state; restore its built-in
		// formatting so a value this describe block pushed cannot leak into an unrelated test.
		resetFormatting();
	});

	it("refuses a locale outside the fixed list", async () => {
		await expect(setSetting("panel.locale", "xx-XX")).rejects.toThrow(ApiError);
	});

	it("refuses a clock value that is not 12h or 24h", async () => {
		await expect(setSetting("panel.timeFormat", "36h")).rejects.toThrow(ApiError);
	});

	it("refuses a zone Intl does not recognise", async () => {
		// panel.timezone is type: "enum", so fits() rejects anything outside its declared `values`
		// (system, plus every zone Intl.supportedValuesOf named at module load) at the store
		// boundary — the same enum check logs.minimumLevel's own refusal test exercises.
		await expect(setSetting("panel.timezone", "Foo/Bar")).rejects.toThrow(ApiError);
	});

	it("stores and reads back a real IANA zone", async () => {
		await setSetting("panel.timezone", "Europe/Helsinki");
		expect(await enumSetting("panel.timezone")).toBe("Europe/Helsinki");
	});

	it("ignores a stored zone Intl no longer recognises, falling back to the default", async () => {
		// Written directly rather than through setSetting, simulating a row saved under a Node/ICU
		// version whose Intl.supportedValuesOf named this zone and a later one that does not. The
		// same "ignore rather than clamp or coerce" rule every other setting follows (see
		// `fits()`'s doc comment) applies here with no extra code.
		await prisma.setting.create({ data: { key: "panel.timezone", value: JSON.stringify("Foo/Bar") } });

		const settings = await listSettings();
		const timezone = settings.find((setting) => setting.definition.key === "panel.timezone");

		expect(timezone?.value).toBe("system");
		expect(timezone?.overridden).toBe(false);
	});

	it("stores the locale as quoted JSON, not as bare text", async () => {
		await setSetting("panel.locale", "fi-FI");
		const row = await prisma.setting.findUnique({ where: { key: "panel.locale" } });
		expect(row?.value).toBe(JSON.stringify("fi-FI"));
		expect(row?.value).toBe('"fi-FI"');
	});

	it("stores the clock as quoted JSON, not as bare text", async () => {
		await setSetting("panel.timeFormat", "24h");
		const row = await prisma.setting.findUnique({ where: { key: "panel.timeFormat" } });
		expect(row?.value).toBe(JSON.stringify("24h"));
		expect(row?.value).toBe('"24h"');
	});

	it("stores the timezone as quoted JSON, not as bare text", async () => {
		await setSetting("panel.timezone", "Europe/Helsinki");
		const row = await prisma.setting.findUnique({ where: { key: "panel.timezone" } });
		expect(row?.value).toBe(JSON.stringify("Europe/Helsinki"));
		expect(row?.value).toBe('"Europe/Helsinki"');
	});
});

/**
 * `images.allowPlainHttp` — the first `type: "boolean"` setting the store has ever held.
 *
 * `fits()`'s boolean branch and `setSetting`'s JSON write path have been exercised only by
 * `logs.minimumLevel`'s enum coverage and `limits.maxLines`'s integer coverage until now; the
 * behaviour this setting actually controls belongs to `fetch-remote.test.ts`, and what belongs
 * here is the same boundary the other variants get: validation at the store, and the raw text
 * written, which for a boolean is the one place a regression could slip past every other test —
 * `String(false)` and `JSON.stringify(false)` are both the four characters `false`, unquoted, so
 * this setting cannot tell a `String(value)` regression apart from a correct write by its raw text
 * alone the way `logs.minimumLevel` or `server.publicUrl` can. What it *can* still prove is that
 * the value round-trips as a real JSON boolean rather than as a string that happens to read the
 * same: `JSON.parse("false")` is the boolean `false`, while a `String(value)` regression on a
 * setting that was `true` would have written `"true"`, which still parses back as a value — a
 * boolean is simply not a variant where round-tripping alone can catch every regression the string
 * and enum equivalents can.
 */
describe("images.allowPlainHttp", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
	});

	it("defaults to true", async () => {
		expect(await booleanSetting("images.allowPlainHttp")).toBe(true);
	});

	it("stores and reads back false", async () => {
		await setSetting("images.allowPlainHttp", false);
		expect(await booleanSetting("images.allowPlainHttp")).toBe(false);
	});

	it("refuses a non-boolean value", async () => {
		await expect(setSetting("images.allowPlainHttp", "false")).rejects.toThrow(ApiError);
		await expect(setSetting("images.allowPlainHttp", 0)).rejects.toThrow(ApiError);
	});

	it("throws when an accessor is pointed at another variant", async () => {
		await expect(integerSetting("images.allowPlainHttp")).rejects.toThrow();
	});

	it("stores the value as JSON, not as quoted text", async () => {
		// The regression this guards against: a write path that quoted every value, or reverted to
		// `String(value)` for a type it did not expect, would store `"false"` — a JSON string, not
		// a JSON boolean — and `parseStored` would hand back a string that `fits()` then refuses,
		// silently reverting the setting to its default on the very next read.
		await setSetting("images.allowPlainHttp", false);
		const row = await prisma.setting.findUnique({ where: { key: "images.allowPlainHttp" } });
		expect(row?.value).toBe("false");
		expect(row?.value).toBe(JSON.stringify(false));
	});
});

/**
 * `pairing.enabled` — the kill switch for `/api/pair`, the one unauthenticated write in the
 * system. What it actually does to the route belongs to `route.test.ts`; what belongs here is
 * the store boundary and the raw text it writes, the same split every other setting's test file
 * follows.
 *
 * The raw-storage assertion matters more here than for most booleans: this setting is read by
 * `route.ts` on every single pairing attempt, so a write path that silently reverted to quoting
 * the value (`"false"`, a JSON string) rather than writing it bare (`false`, a JSON boolean)
 * would make `parseStored` refuse it and `listSettings` fall back to the default — quietly
 * leaving pairing switched on no matter what the operator saved.
 */
describe("pairing.enabled", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
	});

	it("defaults to true", async () => {
		expect(await booleanSetting("pairing.enabled")).toBe(true);
	});

	it("stores and reads back false", async () => {
		await setSetting("pairing.enabled", false);
		expect(await booleanSetting("pairing.enabled")).toBe(false);
	});

	it("refuses a non-boolean value", async () => {
		await expect(setSetting("pairing.enabled", "false")).rejects.toThrow(ApiError);
		await expect(setSetting("pairing.enabled", 0)).rejects.toThrow(ApiError);
	});

	it("stores the value as bare JSON, not as a quoted string", async () => {
		await setSetting("pairing.enabled", false);
		const row = await prisma.setting.findUnique({ where: { key: "pairing.enabled" } });
		expect(row?.value).toBe("false");
		expect(row?.value).toBe(JSON.stringify(false));
	});
});

/**
 * `images.allowedRemoteHosts` — the plan's first `string` setting with a `pattern`, now that
 * `panel.timezone` became an enum. Its pattern carries no `g` or `y` flag, which matters: either
 * flag makes a `RegExp` stateful through `lastIndex`, so `pattern.test()` would alternate between
 * matching and not matching the *same* input across successive calls — and `fits()` calls
 * `definition.pattern.test(value)` on every `setSetting` and every `listSettings()`, so a stateful
 * pattern would make validation depend on how many times it had already run. The second test below
 * calls `setSetting` twice with the same value specifically to catch that.
 *
 * The behaviour the allowlist actually gates belongs to `fetch-remote.test.ts`; what belongs here
 * is validation at the store's boundary and the raw text it writes, the same split every other
 * setting's test file follows.
 */
describe("images.allowedRemoteHosts", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
	});

	it("defaults to the empty string, meaning any host", async () => {
		expect(await stringSetting("images.allowedRemoteHosts")).toBe("");
	});

	it("accepts the empty string", async () => {
		await setSetting("images.allowedRemoteHosts", "cdn.example.com");
		await setSetting("images.allowedRemoteHosts", "");
		expect(await stringSetting("images.allowedRemoteHosts")).toBe("");
	});

	it("accepts a single hostname", async () => {
		await setSetting("images.allowedRemoteHosts", "cdn.example.com");
		expect(await stringSetting("images.allowedRemoteHosts")).toBe("cdn.example.com");
	});

	it("accepts several comma-separated hostnames", async () => {
		await setSetting("images.allowedRemoteHosts", "cdn.example.com, images.example.com");
		expect(await stringSetting("images.allowedRemoteHosts")).toBe("cdn.example.com, images.example.com");
	});

	/** The same value validated twice, to catch a stateful pattern — see this block's doc comment. */
	it("accepts the same value on a second save, proving the pattern is not stateful", async () => {
		await setSetting("images.allowedRemoteHosts", "cdn.example.com");
		await expect(setSetting("images.allowedRemoteHosts", "cdn.example.com")).resolves.toBeUndefined();
	});

	it("refuses a value that is not hostname-shaped", async () => {
		await expect(setSetting("images.allowedRemoteHosts", "not a host")).rejects.toThrow(ApiError);
		await expect(setSetting("images.allowedRemoteHosts", "https://cdn.example.com")).rejects.toThrow(ApiError);
		await expect(setSetting("images.allowedRemoteHosts", "cdn.example.com,")).rejects.toThrow(ApiError);
	});

	it("refuses a value longer than the declared maximum", async () => {
		const definition = SETTINGS.find((setting) => setting.key === "images.allowedRemoteHosts");
		if (definition?.type !== "string") {
			throw new Error("expected images.allowedRemoteHosts to be a string setting");
		}
		const tooLong = `${"a".repeat(definition.maxLength)}.example.com`;
		await expect(setSetting("images.allowedRemoteHosts", tooLong)).rejects.toThrow(ApiError);
	});

	it("throws when an accessor is pointed at another variant", async () => {
		await expect(booleanSetting("images.allowedRemoteHosts")).rejects.toThrow();
	});

	it("stores the value as quoted JSON, not as bare text", async () => {
		await setSetting("images.allowedRemoteHosts", "cdn.example.com");
		const row = await prisma.setting.findUnique({ where: { key: "images.allowedRemoteHosts" } });
		expect(row?.value).toBe(JSON.stringify("cdn.example.com"));
		expect(row?.value).toBe('"cdn.example.com"');
	});
});

/**
 * `assets.acceptedFormats` — an enum gating which image formats `measured()` (`asset-service.ts`)
 * will decode, on top of what the upload dialog's file picker offers. The behaviour it drives
 * belongs to `asset-service.test.ts`; what belongs here is the same store-boundary validation and
 * raw-text assertion every other setting's test file carries.
 */
describe("assets.acceptedFormats", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
	});

	it("defaults to png+jpeg", async () => {
		expect(await enumSetting("assets.acceptedFormats")).toBe("png+jpeg");
	});

	it("stores and reads back png", async () => {
		await setSetting("assets.acceptedFormats", "png");
		expect(await enumSetting("assets.acceptedFormats")).toBe("png");
	});

	it("refuses a value outside the fixed list", async () => {
		await expect(setSetting("assets.acceptedFormats", "gif")).rejects.toThrow(ApiError);
	});

	it("stores the value as quoted JSON, not as bare text", async () => {
		await setSetting("assets.acceptedFormats", "png");
		const row = await prisma.setting.findUnique({ where: { key: "assets.acceptedFormats" } });
		expect(row?.value).toBe(JSON.stringify("png"));
		expect(row?.value).toBe('"png"');
	});
});

describe("raw write settings", () => {
	it("ships with raw API writes switched off", async () => {
		// The whole gate. An upgrade must not turn this on for anybody, and a test that pins the
		// fallback is what stops a future edit doing so by accident — a default flipped here would be
		// invisible in every install that has never touched the setting.
		await prisma.setting.deleteMany();

		expect(await booleanSetting("link.allowRawApiWrites")).toBe(false);
	});

	it("caps a raw write, since nothing else bounds one", async () => {
		await prisma.setting.deleteMany();

		expect(await integerSetting("link.maxRawWriteBytes")).toBeGreaterThan(0);
	});

	it("stores a cap raised to the largest payload a link frame can carry", async () => {
		// 12288 is the bound derived from `rawWriteSchema.shape.bytes` — 16384 base64 characters, three
		// bytes per four characters. Written as the derivation rather than as a number so this test
		// follows the schema if the frame is ever widened.
		const ceiling = Math.floor((rawWriteSchema.shape.bytes.maxLength as number) / 4) * 3;
		expect(ceiling).toBe(12_288);

		await setSetting("link.maxRawWriteBytes", ceiling);

		expect(await integerSetting("link.maxRawWriteBytes")).toBe(ceiling);
	});

	it("refuses a cap the link could not carry, so the panel cannot outrun the wire", async () => {
		// The failure this bound exists to prevent: a value the panel accepts, then a ZodError out of
		// `serialiseServerFrame` that is not an ApiError — a 500, a leaked reply slot, and an audit row
		// claiming an unknown outcome for bytes that never left the server.
		const ceiling = Math.floor((rawWriteSchema.shape.bytes.maxLength as number) / 4) * 3;

		await expect(setSetting("link.maxRawWriteBytes", ceiling + 1)).rejects.toThrow();
		await expect(setSetting("link.maxRawWriteBytes", 100_000)).rejects.toThrow();
	});
});

describe("variable settings", () => {
	it("declares every variable key", () => {
		const keys = SETTINGS.filter((setting) => setting.key.startsWith("variables.")).map((setting) => setting.key);

		expect(keys).toEqual([
			"variables.enabled",
			"variables.allowRequestValues",
			"variables.maxCount",
			"variables.maxValueChars",
			"variables.maxPerRequest",
			"variables.maxPerElement",
			"variables.timezone",
			"variables.locale",
		]);
	});

	it("ships with variables on", () => {
		const enabled = SETTINGS.find((setting) => setting.key === "variables.enabled");

		expect(enabled).toMatchObject({ type: "boolean", fallback: true });
	});

	it("offers the same locales as the panel does", () => {
		const panel = SETTINGS.find((setting) => setting.key === "panel.locale");
		const variables = SETTINGS.find((setting) => setting.key === "variables.locale");

		expect(variables).toMatchObject({ type: "enum" });
		expect(variables && "values" in variables ? variables.values : null).toEqual(
			panel && "values" in panel ? panel.values : undefined,
		);
	});

	it("offers the same zones as the panel does, including the system sentinel", () => {
		const panel = SETTINGS.find((setting) => setting.key === "panel.timezone");
		const variables = SETTINGS.find((setting) => setting.key === "variables.timezone");

		expect(variables && "values" in variables ? variables.values : null).toEqual(
			panel && "values" in panel ? panel.values : undefined,
		);
		expect(variables).toMatchObject({ fallback: "system" });
	});

	it("lists the variables category", () => {
		expect(CATEGORIES.map((category) => category.id)).toContain("variables");
	});

	it("puts every variable setting in that category", () => {
		for (const setting of SETTINGS.filter((one) => one.key.startsWith("variables."))) {
			expect(setting.category).toBe("variables");
		}
	});
});
