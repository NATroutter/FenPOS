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
 * Every value is an integer with a range. There is no free-text setting here, deliberately: a
 * setting nobody can state the bounds of is one nobody can validate.
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

/** One setting, its bounds, and why it exists. */
export interface SettingDefinition {
	key: SettingKey;
	label: string;
	description: string;
	min: number;
	max: number;
	fallback: number;
	unit: string;
}

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
		min: 1,
		max: 10_000,
		fallback: DEFAULT_LIMITS.maxLines,
		unit: "elements",
	},
	{
		key: "limits.maxLineChars",
		label: "Characters per element",
		description: "Measured on the raw string, so the number a client counts matches the one enforced.",
		min: 1,
		max: 10_000,
		fallback: DEFAULT_LIMITS.maxLineChars,
		unit: "characters",
	},
	{
		key: "limits.maxTotalChars",
		label: "Characters per request",
		description: "Across every element combined.",
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
		description: "How long a finished job stays readable before it is swept.",
		min: 1,
		max: 40_320,
		fallback: 1440,
		unit: "minutes",
	},
	{
		key: "jobs.maxRecords",
		label: "Job records kept",
		description: "Hard cap, evicting the oldest finished jobs first. Bounds the table on a busy install.",
		min: 100,
		max: 1_000_000,
		fallback: 10_000,
		unit: "records",
	},
	{
		key: "jobs.shutdownGraceSeconds",
		label: "Shutdown grace",
		description: "How long an agent waits for an in-flight print before failing it. Pushed to every agent.",
		min: 1,
		max: 300,
		fallback: 10,
		unit: "seconds",
	},
];

/** A setting's current value, and whether it is stored or the built-in default. */
export interface SettingValue {
	definition: SettingDefinition;
	value: number;
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
		const raw = stored.get(definition.key);
		const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);

		// A stored value outside its range is ignored rather than clamped. It can only have got
		// there by a hand edit or an older version with wider bounds, and quietly applying half
		// of someone's intention is worse than applying none of it.
		const usable = Number.isInteger(parsed) && parsed >= definition.min && parsed <= definition.max;

		return {
			definition,
			value: usable ? parsed : definition.fallback,
			overridden: usable,
		};
	});
}

/**
 * Reads the limits applied to a request, honouring any stored overrides.
 *
 * @returns the limits in effect install-wide
 */
export async function globalLimits(): Promise<CompileLimits> {
	const settings = await listSettings();
	const value = (key: SettingKey): number => settings.find((setting) => setting.definition.key === key)?.value ?? 0;

	return {
		maxLines: value("limits.maxLines"),
		maxLineChars: value("limits.maxLineChars"),
		maxTotalChars: value("limits.maxTotalChars"),
		maxOutputLines: value("limits.maxOutputLines"),
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
