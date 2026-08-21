import "server-only";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { JOB_LIMITS } from "@/lib/link/protocol";
import { logger } from "@/lib/logger";
import type { CompileLimits } from "@/lib/markup/compiler";

/**
 * Install-wide settings, replacing the globals the YAML file used to carry.
 *
 * **Stored only when changed.** A key with no row means "use the built-in default", so the
 * defaults live in code where they can be read and reasoned about rather than being copied into
 * the database at install time and then diverging silently from what the code believes. It also
 * means an upgrade that improves a default improves it for everyone who never touched it.
 *
 * Every setting declares its own bounds, whatever its type — an integer's range, an enum's
 * values, a string's length. There is no free-text setting with no stated limit, deliberately: a
 * setting nobody can state the bounds of is one nobody can validate. Every setting today happens
 * to be `type: "integer"`; the other variants exist so a later setting can pick the shape that
 * fits it instead of being forced into a number.
 */

/**
 * Built-in limits, applied where neither a device nor this install overrides them.
 *
 * Kept here rather than beside the print path because this is where they are overridden, and a
 * default that lived next to its consumer would have to be imported back the other way — which is
 * a cycle, and was one until it was moved.
 */
export const DEFAULT_LIMITS: CompileLimits = {
	maxLines: 200,
	maxLineChars: 256,
	maxTotalChars: 16_384,
	maxOutputLines: 300,
};

/**
 * Which part of the system a setting affects.
 *
 * Declared per setting rather than derived from the key prefix, because the categories deliberately
 * span prefixes: `auth.*` and `pairing.*` are both security, and `link.*`, `events.*` and `agent.*`
 * are all connections. Deriving from the prefix would mean either a category per prefix — a dozen
 * nav entries — or renaming keys to suit the navigation, and a key is a stored contract.
 */
export type SettingCategory = "general" | "limits" | "jobs" | "logs" | "media" | "security" | "connections" | "panel";

/**
 * The categories in the order the panel lists them.
 *
 * Only the categories with at least one setting appear here — an entry with nothing under it
 * would be a dead spot in the nav. `general`, `logs`, `media`, `security`, `connections` and
 * `panel` join as the settings that belong to them are added.
 */
export const CATEGORIES: readonly { id: SettingCategory; title: string; summary: string }[] = [
	{
		id: "limits",
		title: "Print limits",
		summary: "Counted on the request as received, before markup is interpreted.",
	},
	{ id: "jobs", title: "Jobs", summary: "How much job history each agent keeps, and how a shutdown waits." },
];

/** What every setting carries, whatever its type. */
interface SettingBase {
	key: SettingKey;
	label: string;
	description: string;
	category: SettingCategory;
}

/**
 * One setting, its bounds, and why it exists.
 *
 * A union rather than one interface with optional fields: an integer's `min` and an enum's `values`
 * are not the same field made optional, and a definition that could carry both is one the form has
 * to interrogate at render time. Discriminating on `type` means each variant carries exactly the
 * constraints that variant can be validated against, which is the module's stated principle — a
 * setting nobody can state the bounds of is one nobody can validate.
 */
export type SettingDefinition =
	| (SettingBase & { type: "integer"; min: number; max: number; fallback: number; unit: string })
	| (SettingBase & { type: "boolean"; fallback: boolean })
	| (SettingBase & { type: "enum"; values: readonly string[]; fallback: string })
	| (SettingBase & { type: "string"; maxLength: number; pattern?: RegExp; fallback: string });

/** The four kinds of value a setting can hold. */
export type SettingType = SettingDefinition["type"];

/** Keys of every setting. Persisted verbatim, so these strings are a stored contract. */
export const SETTING_KEYS = [
	"limits.maxLines",
	"limits.maxLineChars",
	"limits.maxTotalChars",
	"limits.maxOutputLines",
	"jobs.retentionMinutes",
	"jobs.maxRecords",
	"jobs.shutdownGraceSeconds",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

/**
 * Every setting in the order the panel renders it.
 *
 * The limit defaults are read from the dispatcher rather than restated, so the number shown as
 * "default" is the number actually applied to a device that overrides nothing.
 */
export const SETTINGS: readonly SettingDefinition[] = [
	{
		key: "limits.maxLines",
		label: "Elements per request",
		description: "Most entries a request's data array may hold, before markup is interpreted.",
		category: "limits",
		type: "integer",
		min: 1,
		max: 10_000,
		fallback: DEFAULT_LIMITS.maxLines,
		unit: "elements",
	},
	{
		key: "limits.maxLineChars",
		label: "Characters per element",
		description: "Measured on the raw string, so the number a client counts matches the one enforced.",
		category: "limits",
		type: "integer",
		min: 1,
		max: 10_000,
		fallback: DEFAULT_LIMITS.maxLineChars,
		unit: "characters",
	},
	{
		key: "limits.maxTotalChars",
		label: "Characters per request",
		description: "Across every element combined.",
		category: "limits",
		type: "integer",
		min: 1,
		max: 1_000_000,
		fallback: DEFAULT_LIMITS.maxTotalChars,
		unit: "characters",
	},
	{
		key: "limits.maxOutputLines",
		label: "Printed lines per job",
		description:
			"Applied after wrapping, which is the only place it can catch a short request that expands into a long receipt.",
		category: "limits",
		type: "integer",
		min: 1,
		// Derived, not restated. The dispatch frame refuses more than this (`protocol.ts` line 64)
		// and so does the agent, so a higher setting produces jobs that compile and then fail to
		// serialise — which is what it did until this became a reference rather than a number.
		max: JOB_LIMITS.maxLines,
		fallback: DEFAULT_LIMITS.maxOutputLines,
		unit: "lines",
	},
	{
		key: "jobs.retentionMinutes",
		label: "Job retention",
		description: "How long a finished job stays readable before it is swept. Pushed to every agent.",
		category: "jobs",
		type: "integer",
		min: 1,
		max: 40_320,
		fallback: 1440,
		unit: "minutes",
	},
	{
		key: "jobs.maxRecords",
		label: "Job records kept",
		description:
			"Hard cap, evicting the oldest finished jobs first. Bounds memory on a busy agent. Pushed to every agent.",
		category: "jobs",
		type: "integer",
		min: 100,
		max: 1_000_000,
		fallback: 10_000,
		unit: "records",
	},
	{
		key: "jobs.shutdownGraceSeconds",
		label: "Shutdown grace",
		description: "How long an agent waits for an in-flight print before failing it. Pushed to every agent.",
		category: "jobs",
		type: "integer",
		min: 1,
		max: 300,
		fallback: 10,
		unit: "seconds",
	},
];

/** A setting's current value, and whether it is stored or the built-in default. */
export interface SettingValue {
	definition: SettingDefinition;
	value: number | string | boolean;
	/** False when no row exists, so the panel can say the default is in effect. */
	overridden: boolean;
}

/**
 * Reads every setting, filling in defaults where nothing is stored.
 *
 * @returns each setting with its current value
 */
export async function listSettings(): Promise<SettingValue[]> {
	const rows = await prisma.setting.findMany({ where: { key: { in: [...SETTING_KEYS] } } });
	const stored = new Map(rows.map((row) => [row.key, row.value]));

	return SETTINGS.map((definition) => {
		const parsed = parseStored(stored.get(definition.key));
		const usable = parsed !== undefined && fits(definition, parsed);

		return {
			definition,
			value: usable ? parsed : definition.fallback,
			overridden: usable,
		};
	});
}

/**
 * Reads a stored value as JSON.
 *
 * Rows written before settings became JSON hold a bare integer — `200`, not `"200"` — which is
 * itself valid JSON, so those rows parse here without a special case. That is what makes this
 * change need no migration.
 *
 * @param raw the stored text, or undefined when nothing is stored
 * @returns the parsed value, or undefined when nothing is stored or the text is not JSON
 */
function parseStored(raw: string | undefined): number | string | boolean | undefined {
	if (raw === undefined) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "number" || typeof parsed === "string" || typeof parsed === "boolean" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether a value is one this setting can hold.
 *
 * A stored value that does not fit is ignored rather than clamped or coerced. It can only have got
 * there by a hand edit or an older version with different bounds, and quietly applying half of
 * someone's intention is worse than applying none of it.
 *
 * @param definition the setting
 * @param value a value parsed from storage or submitted by the form
 * @returns whether the value matches the definition's type and constraints
 */
function fits(definition: SettingDefinition, value: unknown): boolean {
	switch (definition.type) {
		case "integer":
			return typeof value === "number" && Number.isInteger(value) && value >= definition.min && value <= definition.max;
		case "boolean":
			return typeof value === "boolean";
		case "enum":
			return typeof value === "string" && definition.values.includes(value);
		case "string":
			return (
				typeof value === "string" &&
				value.length <= definition.maxLength &&
				(definition.pattern === undefined || definition.pattern.test(value))
			);
	}
}

/**
 * Reads the limits applied to a request, honouring any stored overrides.
 *
 * @returns the limits in effect install-wide
 */
export async function globalLimits(): Promise<CompileLimits> {
	const settings = await listSettings();
	const value = (key: SettingKey): number => {
		const found = settings.find((setting) => setting.definition.key === key)?.value;
		// Every key this function names is declared `type: "integer"`, asserted by the test that
		// walks SETTINGS. A non-number here is a definition that changed type without its readers
		// being updated, which is a programming error rather than a stored value.
		if (typeof found !== "number") {
			throw new Error(`Setting '${key}' is not an integer setting.`);
		}
		return found;
	};

	return {
		maxLines: value("limits.maxLines"),
		maxLineChars: value("limits.maxLineChars"),
		maxTotalChars: value("limits.maxTotalChars"),
		maxOutputLines: value("limits.maxOutputLines"),
	};
}

/** Job retention and shutdown as configured, in the shape `config.sync` carries. */
export interface GlobalJobSettings {
	retentionMinutes: number;
	maxRecords: number;
	shutdownGraceSeconds: number;
}

/**
 * Reads the job settings pushed to every agent.
 *
 * Separate from {@link globalLimits} because the two go to different places: limits are applied
 * here, on the request, while these are applied on the machine holding the printer.
 *
 * @returns the job settings in effect install-wide
 */
export async function globalJobSettings(): Promise<GlobalJobSettings> {
	const settings = await listSettings();
	const value = (key: SettingKey): number => {
		const found = settings.find((setting) => setting.definition.key === key)?.value;
		// Every key this function names is declared `type: "integer"`, asserted by the test that
		// walks SETTINGS. A non-number here is a definition that changed type without its readers
		// being updated, which is a programming error rather than a stored value.
		if (typeof found !== "number") {
			throw new Error(`Setting '${key}' is not an integer setting.`);
		}
		return found;
	};

	return {
		retentionMinutes: value("jobs.retentionMinutes"),
		maxRecords: value("jobs.maxRecords"),
		shutdownGraceSeconds: value("jobs.shutdownGraceSeconds"),
	};
}

/**
 * Stores a setting.
 *
 * @param key which setting
 * @param value the new value
 * @throws ApiError when the key is unknown or the value is out of range
 */
export async function setSetting(key: string, value: number): Promise<void> {
	const definition = SETTINGS.find((setting) => setting.key === key);
	if (!definition) {
		throw new ApiError("invalid_type", `'${key}' is not a setting.`);
	}
	if (definition.type !== "integer") {
		// Every definition today is `type: "integer"`, asserted by the test that walks SETTINGS.
		// Task 6 teaches this function to validate the other variants; until then, reaching here
		// is a definition that changed type without this function being updated.
		throw new Error(`Setting '${key}' is not an integer setting.`);
	}
	if (!Number.isInteger(value) || value < definition.min || value > definition.max) {
		throw new ApiError(
			"invalid_type",
			`${definition.label} must be a whole number between ${definition.min} and ${definition.max}.`,
		);
	}

	await prisma.setting.upsert({
		where: { key },
		update: { value: String(value) },
		create: { key, value: String(value) },
	});

	logger.info("Setting changed", { key, value });
}

/**
 * Removes a stored setting, returning it to the built-in default.
 *
 * @param key which setting
 */
export async function clearSetting(key: string): Promise<void> {
	await prisma.setting.deleteMany({ where: { key } });
	logger.info("Setting reset to its default", { key });
}
