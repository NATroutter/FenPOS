import "server-only";
import { prisma } from "@/lib/db";
import { LogLevel } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";
import { JOB_LIMITS } from "@/lib/link/protocol";
import { logger, setMinimumLevel } from "@/lib/logger";
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
	{ id: "logs", title: "Logs", summary: "How much output is written and kept." },
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

/**
 * A {@link SettingDefinition}, minus `pattern` — the one field that must never reach a client
 * component.
 *
 * `pattern` is a `RegExp`, and a `RegExp` is not serialisable across React's server→client
 * boundary: handing one to a client component does not fail at build time, it throws at render
 * time, the moment a string setting that carries one is rendered. The client has no legitimate
 * use for it regardless — validation is server-side by design, `setSetting` below is the security
 * boundary, and a rejected value comes back as a toast — so the client only ever needs
 * `maxLength`, kept as a convenience attribute on the input.
 *
 * **Do not add `pattern` back to "complete" this type.** That reintroduces the exact crash this
 * type exists to prevent. Use {@link toClientDefinition} to produce one from a `SettingDefinition`.
 */
export type ClientSettingDefinition =
	| Exclude<SettingDefinition, { type: "string" }>
	| Omit<Extract<SettingDefinition, { type: "string" }>, "pattern">;

/**
 * Strips `pattern` from a definition before it is handed to a client component.
 *
 * A type alone does not remove the field from the value at runtime — TypeScript types are erased
 * at compile time, so merely annotating the result as {@link ClientSettingDefinition} would still
 * pass React the same object, `pattern` and all. This function is the one place the field is
 * actually dropped, and it must run before a definition crosses into a client component (today,
 * that is the settings page building props for `SettingsForm`).
 *
 * @param definition a definition as declared in {@link SETTINGS}
 * @returns the same definition, without `pattern`
 */
export function toClientDefinition(definition: SettingDefinition): ClientSettingDefinition {
	if (definition.type !== "string") {
		return definition;
	}
	const { pattern: _pattern, ...rest } = definition;
	return rest;
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
	"logs.minimumLevel",
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
	{
		key: "logs.minimumLevel",
		label: "Minimum level",
		description:
			"Lines below this are dropped. DEBUG is loud enough to be worth turning off again once whatever you are chasing is found.",
		category: "logs",
		type: "enum",
		values: LogLevel.values,
		fallback: "INFO",
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
 * Narrows an already-loaded setting to the type the caller requires.
 *
 * Shared by the typed accessors and by {@link globalLimits}/{@link globalJobSettings}, which each
 * narrow several settings out of one `listSettings()` call rather than fetching once per setting.
 *
 * @param settings every setting, as returned by `listSettings`
 * @param key which setting
 * @param type the variant the caller requires
 * @returns the current value
 * @throws Error when the setting is not of the required type
 */
function narrow(settings: SettingValue[], key: SettingKey, type: SettingType): number | string | boolean {
	const found = settings.find((setting) => setting.definition.key === key);
	if (!found) {
		throw new Error(`'${key}' is not a setting.`);
	}
	if (found.definition.type !== type) {
		throw new Error(`Setting '${key}' is ${found.definition.type}, not ${type}.`);
	}
	return found.value;
}

/**
 * Reads the limits applied to a request, honouring any stored overrides.
 *
 * @returns the limits in effect install-wide
 */
export async function globalLimits(): Promise<CompileLimits> {
	const settings = await listSettings();
	// Every key named below is declared `type: "integer"`, asserted by the test that walks
	// SETTINGS. A mismatch here is a definition that changed type without its readers being
	// updated, which is a programming error rather than a stored value.
	const value = (key: SettingKey): number => narrow(settings, key, "integer") as number;

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
	// Every key named below is declared `type: "integer"`, asserted by the test that walks
	// SETTINGS. A mismatch here is a definition that changed type without its readers being
	// updated, which is a programming error rather than a stored value.
	const value = (key: SettingKey): number => narrow(settings, key, "integer") as number;

	return {
		retentionMinutes: value("jobs.retentionMinutes"),
		maxRecords: value("jobs.maxRecords"),
		shutdownGraceSeconds: value("jobs.shutdownGraceSeconds"),
	};
}

/**
 * Stores a setting.
 *
 * `value` is `unknown` because the caller is a server action, which is a public POST endpoint —
 * whatever arrives has been across the wire and is not typed by anything the browser did. The
 * validation here is the boundary, not a convenience for the form.
 *
 * @param key which setting
 * @param value the new value, validated against the setting's declared type
 * @throws ApiError when the key is unknown or the value is not one this setting can hold
 */
export async function setSetting(key: string, value: unknown): Promise<void> {
	const definition = SETTINGS.find((setting) => setting.key === key);
	if (!definition) {
		throw new ApiError("invalid_type", `'${key}' is not a setting.`);
	}
	if (!fits(definition, value)) {
		throw new ApiError("invalid_type", `${definition.label} ${expectation(definition)}.`);
	}

	const stored = JSON.stringify(value);
	await prisma.setting.upsert({
		where: { key },
		update: { value: stored },
		create: { key, value: stored },
	});

	logger.info("Setting changed", { key, value });
	await applyPushedSettings();
}

/**
 * Says what a setting will accept, for the message shown when it did not get it.
 *
 * @param definition the setting
 * @returns a phrase completing "<label> ..."
 */
function expectation(definition: SettingDefinition): string {
	switch (definition.type) {
		case "integer":
			return `must be a whole number between ${definition.min} and ${definition.max}`;
		case "boolean":
			return "must be on or off";
		case "enum":
			return `must be one of ${definition.values.join(", ")}`;
		case "string":
			return `must be text of at most ${definition.maxLength} characters`;
	}
}

/**
 * Reads one setting, insisting it is the type the caller expects.
 *
 * A mismatch is a programming error — a definition whose type changed without its readers being
 * updated — so it throws rather than returning a fallback. The alternative is a caller silently
 * receiving a string where it expected a number.
 *
 * @param key which setting
 * @param type the variant the caller requires
 * @returns the current value
 * @throws Error when the setting is not of the required type
 */
async function typedSetting(key: SettingKey, type: SettingType): Promise<number | string | boolean> {
	return narrow(await listSettings(), key, type);
}

/**
 * The current value of an integer setting.
 *
 * @param key which setting
 * @returns the current value
 * @throws Error when the setting is not declared `type: "integer"`
 */
export async function integerSetting(key: SettingKey): Promise<number> {
	return (await typedSetting(key, "integer")) as number;
}

/**
 * The current value of a boolean setting.
 *
 * @param key which setting
 * @returns the current value
 * @throws Error when the setting is not declared `type: "boolean"`
 */
export async function booleanSetting(key: SettingKey): Promise<boolean> {
	return (await typedSetting(key, "boolean")) as boolean;
}

/**
 * The current value of an enum setting, narrowed to the caller's own union.
 *
 * The narrowing to `T` is not checked here — the definition's `values` are typed as
 * `readonly string[]`, so the caller's more specific union is taken on trust, the same way a
 * database read is.
 *
 * @param key which setting
 * @returns the current value
 * @throws Error when the setting is not declared `type: "enum"`
 */
export async function enumSetting<T extends string>(key: SettingKey): Promise<T> {
	return (await typedSetting(key, "enum")) as T;
}

/**
 * The current value of a string setting.
 *
 * @param key which setting
 * @returns the current value
 * @throws Error when the setting is not declared `type: "string"`
 */
export async function stringSetting(key: SettingKey): Promise<string> {
	return (await typedSetting(key, "string")) as string;
}

/**
 * Removes a stored setting, returning it to the built-in default.
 *
 * @param key which setting
 */
export async function clearSetting(key: string): Promise<void> {
	await prisma.setting.deleteMany({ where: { key } });
	logger.info("Setting reset to its default", { key });
	await applyPushedSettings();
}

/**
 * Applies the settings that are read from synchronous code.
 *
 * Most settings are read where they are used, inside async server code. Some cannot be: the logger's
 * `write` is synchronous and runs on every line, so it cannot await a database read. Modules like
 * that hold a mutable current value and this function pushes into it — at startup, and after any
 * change, so a saved setting takes effect without a restart.
 *
 * The log level is the only one today. The panel's date formatting joins it when `panel.locale`
 * ships, for the same reason: `formatDateTime` is synchronous and called during render.
 *
 * Failures are logged and swallowed. A settings read that fails must not stop the server starting,
 * and the modules involved all have a working built-in value.
 */
export async function applyPushedSettings(): Promise<void> {
	try {
		setMinimumLevel(await enumSetting<LogLevel>("logs.minimumLevel"));
	} catch (error) {
		logger.error("Could not apply pushed settings", error);
	}
}
