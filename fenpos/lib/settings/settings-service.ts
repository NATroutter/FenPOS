import "server-only";
import { prisma } from "@/lib/db";
import { LogLevel } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";
import { resetFormatting, setFormatting } from "@/lib/format/datetime";
import { JOB_LIMITS, jobSettingsSchema } from "@/lib/link/protocol";
import { logger, resetMinimumLevel, setMinimumLevel } from "@/lib/logger";
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
 * setting nobody can state the bounds of is one nobody can validate. Four variants exist —
 * integer, boolean, enum, string — so a setting can pick the shape that actually fits it instead
 * of being forced into a number.
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
 * The zones `panel.timezone` may be set to: the ambient `system` sentinel, plus every IANA zone
 * this Node runtime knows about.
 *
 * Computed once at module load rather than per-request — `Intl.supportedValuesOf` is stable for
 * the life of one process, so recomputing it on every `listSettings()` call would just repeat the
 * same allocation. A value stored while a *different* Node/ICU version was running can fall out of
 * this list across an upgrade; `fits()` then rejects it like any other stored value outside a
 * setting's current bounds, and `listSettings` falls back to `system` rather than clamping or
 * coercing it — the same "ignore rather than guess" rule every other setting follows.
 */
const TIME_ZONES = ["system", ...Intl.supportedValuesOf("timeZone")] as const;

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
 * would be a dead spot in the nav. `panel` joins as the settings that belong to it are added.
 */
export const CATEGORIES: readonly { id: SettingCategory; title: string; summary: string }[] = [
	{ id: "general", title: "General", summary: "How this install identifies itself." },
	{
		id: "limits",
		title: "Print limits",
		summary: "Counted on the request as received, before markup is interpreted.",
	},
	{ id: "jobs", title: "Jobs", summary: "How much job history each agent keeps, and how a shutdown waits." },
	{ id: "logs", title: "Logs", summary: "How much output is written and kept." },
	{ id: "media", title: "Images & assets", summary: "Uploads, and the images a job may fetch." },
	{ id: "security", title: "Security", summary: "Sessions, sign-in, and pairing." },
	{ id: "connections", title: "Connections", summary: "Timeouts on the links to agents and to this panel." },
	{ id: "panel", title: "Panel", summary: "How this interface displays things." },
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

/**
 * Reads the min and max a `jobSettingsSchema` field declares, so a `jobs.*` setting's bounds are
 * derived rather than restated.
 *
 * The two fields share one number in three places already — this schema, the agent's
 * `FrameCodec.readJobSettings`, and (until this function existed) a literal copy here — and a
 * bound widened in `SETTINGS` without a matching widening in `jobSettingsSchema` is exactly how
 * `limits.maxOutputLines` used to fail: a setting the panel accepts that `serialiseServerFrame`
 * then refuses, caught only by `pushDeviceConfig`'s catch-and-log, so the agent silently never
 * receives the change. Deriving from the schema instead means widening it here is the only edit
 * `jobs.*` bounds ever need.
 *
 * `.minValue`/`.maxValue` type as `number | null` because a Zod number schema need not declare
 * either; every `jobSettingsSchema` field does, and `setting definitions` (settings-service.test.ts)
 * asserts as much, so the throw below is unreachable in practice rather than a case this module
 * has to recover from.
 *
 * @param field a field of {@link jobSettingsSchema}
 * @returns that field's declared bounds
 * @throws Error when the field declares no min or no max
 */
function jobBound(field: { minValue: number | null; maxValue: number | null }): { min: number; max: number } {
	if (field.minValue === null || field.maxValue === null) {
		throw new Error("jobSettingsSchema field declares no bound to derive from");
	}
	return { min: field.minValue, max: field.maxValue };
}

/** Keys of every setting. Persisted verbatim, so these strings are a stored contract. */
export const SETTING_KEYS = [
	"server.publicUrl",
	"limits.maxLines",
	"limits.maxLineChars",
	"limits.maxTotalChars",
	"limits.maxOutputLines",
	"jobs.retentionMinutes",
	"jobs.maxRecords",
	"jobs.shutdownGraceSeconds",
	"assets.maxUploadKb",
	"assets.acceptedFormats",
	"images.maxRemoteReferences",
	"images.remoteFetchTimeoutMs",
	"images.allowPlainHttp",
	"images.allowedRemoteHosts",
	"logs.minimumLevel",
	"logs.linesPerMinutePerAgent",
	"logs.maxRecords",
	"logs.maxMessageChars",
	"pairing.codeMinutes",
	"auth.sessionHours",
	"auth.signInAttemptsPerMinute",
	"auth.minimumPasswordLength",
	"events.keepaliveSeconds",
	"link.heartbeatSeconds",
	"link.heartbeatTimeoutSeconds",
	"link.handshakeTimeoutSeconds",
	"link.commandTimeoutSeconds",
	"link.scanTimeoutSeconds",
	"panel.jobPageSize",
	"panel.logPageSize",
	"panel.dashboardWindowHours",
	"panel.dashboardTailLines",
	"panel.locale",
	"panel.timeFormat",
	"panel.timezone",
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
		key: "server.publicUrl",
		label: "Public address",
		description:
			"The address agents dial. Set it when the panel is reached on a different address than agents use; leave it empty to use whatever address the request arrived on.",
		category: "general",
		type: "string",
		maxLength: 255,
		// Absolute http or https only. The empty string is allowed by the length check above and
		// means "derive from the request", which is what an install that has never set this does.
		pattern: /^$|^https?:\/\/[^\s/$.?#][^\s]*$/i,
		fallback: "",
	},
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
		...jobBound(jobSettingsSchema.shape.retentionMinutes),
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
		...jobBound(jobSettingsSchema.shape.maxRecords),
		fallback: 10_000,
		unit: "records",
	},
	{
		key: "jobs.shutdownGraceSeconds",
		label: "Shutdown grace",
		description: "How long an agent waits for an in-flight print before failing it. Pushed to every agent.",
		category: "jobs",
		type: "integer",
		...jobBound(jobSettingsSchema.shape.shutdownGraceSeconds),
		fallback: 10,
		unit: "seconds",
	},
	{
		key: "assets.maxUploadKb",
		label: "Maximum upload size",
		description:
			"Largest image accepted, uploaded or fetched. The decode is bounded separately by a fixed pixel limit, so this is about storage rather than safety.",
		category: "media",
		type: "integer",
		min: 256,
		max: 8_192,
		fallback: 2_048,
		unit: "KiB",
	},
	{
		key: "assets.acceptedFormats",
		label: "Accepted image formats",
		description:
			"Which formats may be uploaded. JPEG is the more expensive decode; a site that only uploads logos can turn it off.",
		category: "media",
		type: "enum",
		values: ["png+jpeg", "png"] as const,
		fallback: "png+jpeg",
	},
	{
		key: "images.maxRemoteReferences",
		label: "Remote images per job",
		description: "Distinct URLs one job may fetch. Set it to 0 to switch off outbound image fetching entirely.",
		category: "media",
		type: "integer",
		min: 0,
		max: 48,
		fallback: 12,
		unit: "images",
	},
	{
		key: "images.remoteFetchTimeoutMs",
		label: "Remote fetch timeout",
		description: "How long a print waits on a remote image host before giving up on it.",
		category: "media",
		type: "integer",
		min: 250,
		max: 15_000,
		fallback: 3_000,
		unit: "ms",
	},
	{
		key: "images.allowPlainHttp",
		label: "Allow plain http images",
		description:
			"Whether images may be fetched over http as well as https. Switch it off on a site that should never fetch in the clear.",
		category: "media",
		type: "boolean",
		fallback: true,
	},
	{
		key: "images.allowedRemoteHosts",
		label: "Allowed image hosts",
		description:
			"Comma-separated hostnames that images may be fetched from. Leave it empty to allow any host. Matching is exact — a listed host does not admit its subdomains.",
		category: "media",
		type: "string",
		maxLength: 512,
		pattern: /^$|^[A-Za-z0-9.-]+(?:\s*,\s*[A-Za-z0-9.-]+)*$/,
		fallback: "",
	},
	{
		key: "logs.minimumLevel",
		label: "Minimum level",
		description:
			"Lines below this are dropped. DEBUG is loud enough to be worth turning off again once whatever you are chasing is found. A development server starts at DEBUG regardless of this default — only a production build, or an explicit override, actually starts here.",
		category: "logs",
		type: "enum",
		values: LogLevel.values,
		fallback: "INFO",
	},
	{
		key: "logs.linesPerMinutePerAgent",
		label: "Lines per minute per agent",
		description:
			"Lines above this are dropped and a throttle notice is stored instead. Raise it while chasing a problem on a chatty agent.",
		category: "logs",
		type: "integer",
		min: 10,
		max: 5_000,
		fallback: 120,
		unit: "lines/min",
	},
	{
		key: "logs.maxRecords",
		label: "Log records kept",
		description: "Hard cap, sweeping the oldest lines first. Bounds the table on a busy install.",
		category: "logs",
		type: "integer",
		min: 1_000,
		max: 1_000_000,
		fallback: 20_000,
		unit: "records",
	},
	{
		key: "logs.maxMessageChars",
		label: "Message length",
		description: "Where a stored log message is truncated. A long stack trace is the case that hits it.",
		category: "logs",
		type: "integer",
		min: 200,
		max: 8_000,
		fallback: 1_000,
		unit: "characters",
	},
	{
		key: "pairing.codeMinutes",
		label: "Pairing code lifetime",
		description:
			"How long a pairing code stays redeemable. Long enough to walk the code to the machine, short enough that a forgotten one expires.",
		category: "security",
		type: "integer",
		min: 1,
		max: 120,
		fallback: 15,
		unit: "minutes",
	},
	{
		key: "auth.sessionHours",
		label: "Session lifetime",
		description:
			"How long a panel sign-in lasts. A shared back-office terminal wants hours; a private office wants days. Applies to sessions created after the change — one already signed in keeps the lifetime it was issued.",
		category: "security",
		type: "integer",
		min: 1,
		max: 720,
		fallback: 12,
		unit: "hours",
	},
	{
		key: "auth.signInAttemptsPerMinute",
		label: "Sign-in attempts per minute",
		description:
			"Failed sign-ins allowed before the panel refuses to try. The floor is the built-in value — this can be tightened, never loosened.",
		category: "security",
		type: "integer",
		min: 3,
		max: 60,
		fallback: 5,
		unit: "attempts/min",
	},
	{
		key: "auth.minimumPasswordLength",
		label: "Minimum password length",
		description:
			"Shortest acceptable administrator password. The floor is the built-in value — this can be raised, never lowered. Existing passwords are unaffected until they are changed. The pnpm admin:set-password recovery command enforces only the built-in floor, not this setting.",
		category: "security",
		type: "integer",
		min: 12,
		max: 128,
		fallback: 12,
		unit: "characters",
	},
	{
		key: "events.keepaliveSeconds",
		label: "Live-stream keepalive",
		description:
			"How often the panel's live stream sends a comment to keep the connection open. Lower it if a proxy closes idle connections sooner than this.",
		category: "connections",
		type: "integer",
		min: 5,
		max: 120,
		fallback: 25,
		unit: "seconds",
	},
	{
		key: "link.heartbeatSeconds",
		label: "Agent heartbeat interval",
		description:
			"How often the server pings a connected agent. These are native WebSocket pings, answered automatically.",
		category: "connections",
		type: "integer",
		min: 5,
		max: 300,
		fallback: 30,
		unit: "seconds",
	},
	{
		key: "link.heartbeatTimeoutSeconds",
		label: "Heartbeat grace",
		description:
			"How long a silent agent has to answer a ping before the server drops it. Keep it below the heartbeat interval.",
		category: "connections",
		type: "integer",
		min: 3,
		max: 120,
		fallback: 10,
		unit: "seconds",
	},
	{
		key: "link.handshakeTimeoutSeconds",
		label: "Handshake timeout",
		description: "How long an agent has to finish its handshake after connecting.",
		category: "connections",
		type: "integer",
		min: 3,
		max: 120,
		fallback: 10,
		unit: "seconds",
	},
	{
		key: "link.commandTimeoutSeconds",
		label: "Command timeout",
		description: "How long the panel waits for an agent to answer a device command.",
		category: "connections",
		type: "integer",
		min: 5,
		max: 120,
		fallback: 15,
		unit: "seconds",
	},
	{
		key: "link.scanTimeoutSeconds",
		label: "Port scan timeout",
		description: "How long the panel waits for a port scan. A machine with many serial ports needs longer.",
		category: "connections",
		type: "integer",
		min: 5,
		max: 180,
		fallback: 20,
		unit: "seconds",
	},
	{
		key: "panel.jobPageSize",
		label: "Jobs per page",
		description: "Rows in the Jobs table before it pages.",
		category: "panel",
		type: "integer",
		min: 10,
		max: 500,
		fallback: 50,
		unit: "rows",
	},
	{
		key: "panel.logPageSize",
		label: "Log lines per page",
		description: "Rows in the Logs table before it pages.",
		category: "panel",
		type: "integer",
		min: 10,
		max: 500,
		fallback: 100,
		unit: "rows",
	},
	{
		key: "panel.dashboardWindowHours",
		label: "Dashboard window",
		description:
			"How far back the Dashboard's job counts reach. The two headline figures name this number in their labels.",
		category: "panel",
		type: "integer",
		min: 1,
		max: 720,
		fallback: 24,
		unit: "hours",
	},
	{
		key: "panel.dashboardTailLines",
		label: "Dashboard log tail",
		description:
			"Lines in the Dashboard's recent-log panel. Enough to see what just happened, not enough to become the Logs tab.",
		category: "panel",
		type: "integer",
		min: 3,
		max: 100,
		fallback: 12,
		unit: "lines",
	},
	{
		key: "panel.locale",
		label: "Date format",
		description: "Which locale's conventions dates and times are written in. The panel's own wording stays English.",
		category: "panel",
		type: "enum",
		values: ["en-US", "en-GB", "fi-FI", "sv-SE", "de-DE", "fr-FR"] as const,
		fallback: "en-US",
	},
	{
		key: "panel.timeFormat",
		label: "Clock",
		description: "Whether times are written on a 12-hour or 24-hour clock, independently of the date format.",
		category: "panel",
		type: "enum",
		values: ["12h", "24h"] as const,
		fallback: "12h",
	},
	{
		key: "panel.timezone",
		label: "Time zone",
		description:
			"Which zone timestamps are shown in. `system` uses the server's own zone, which is right when the panel and its printers are on one site.",
		category: "panel",
		type: "enum",
		// Every zone this Node runtime's ICU data knows, plus the `system` sentinel — see
		// {@link TIME_ZONES}. An enum rather than a pattern-checked string because `fits()`'s
		// membership check (`definition.values.includes(value)`) then does, for free, exactly the
		// "is this a zone Intl actually knows" check a hand-rolled pattern could only approximate:
		// a well-formed-looking zone that Intl does not recognise can never be stored in the first
		// place, so nothing downstream has to guard against one reaching a formatter.
		values: TIME_ZONES,
		fallback: "system",
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

/** The log ingestion limits as configured, in the shape `lib/logs/ingest.ts` reads. */
export interface GlobalLogIngestSettings {
	linesPerMinutePerAgent: number;
	maxRecords: number;
	maxMessageChars: number;
}

/**
 * Reads the log ingestion settings as one object, honouring overrides.
 *
 * Separate from {@link globalLimits} and {@link globalJobSettings} because these three go to a
 * third place: the per-line log ingest path (`lib/logs/ingest.ts`), which caches the result rather
 * than calling this for every line — the same reason `globalLimits`/`globalJobSettings` read once
 * per group instead of once per setting, applied one level up.
 *
 * @returns the log ingestion settings in effect install-wide
 */
export async function globalLogIngestSettings(): Promise<GlobalLogIngestSettings> {
	const settings = await listSettings();
	// Every key named below is declared `type: "integer"`, asserted by the test that walks
	// SETTINGS. A mismatch here is a definition that changed type without its readers being
	// updated, which is a programming error rather than a stored value.
	const value = (key: SettingKey): number => narrow(settings, key, "integer") as number;

	return {
		linesPerMinutePerAgent: value("logs.linesPerMinutePerAgent"),
		maxRecords: value("logs.maxRecords"),
		maxMessageChars: value("logs.maxMessageChars"),
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
 * `logs.minimumLevel` distinguishes stored from default rather than always pushing a value: when it
 * is **overridden**, that value is pushed; when it is not, `resetMinimumLevel()` puts the logger back
 * on its own built-in default instead of pushing the setting's `fallback`. The two are not
 * interchangeable — the fallback is `"INFO"`, chosen as what the panel should display and what a
 * production start should use, while the logger's built-in is `DEBUG` outside production. Pushing
 * the fallback on every untouched install would quietly drop a development server from DEBUG to
 * INFO moments after boot; skipping the push entirely would leave a *cleared* setting stuck at
 * whatever level was last pushed, defeating the reset. `resetMinimumLevel()` is the third option
 * that gets both right.
 *
 * Reads every setting with one `listSettings()` call rather than one query per pushed setting —
 * `panel.locale`, `panel.timeFormat` and `panel.timezone` join `logs.minimumLevel` here as they
 * ship, and a query per setting would mean a query per one of those on every save.
 *
 * Failures are logged and swallowed. A settings read that fails must not stop the server starting,
 * and the modules involved all have a working built-in value.
 */
export async function applyPushedSettings(): Promise<void> {
	try {
		const settings = await listSettings();
		const minimumLevel = settings.find((setting) => setting.definition.key === "logs.minimumLevel");
		if (minimumLevel?.overridden) {
			setMinimumLevel(minimumLevel.value as LogLevel);
		} else {
			resetMinimumLevel();
		}

		const locale = settings.find((setting) => setting.definition.key === "panel.locale");
		const timeFormat = settings.find((setting) => setting.definition.key === "panel.timeFormat");
		const timezone = settings.find((setting) => setting.definition.key === "panel.timezone");

		if (!locale?.overridden && !timeFormat?.overridden && !timezone?.overridden) {
			resetFormatting();
		} else {
			setFormatting(formattingFromSettings(settings));
		}
	} catch (error) {
		logger.error("Could not apply pushed settings", error);
	}
}

/**
 * Resolves `panel.locale`, `panel.timeFormat` and `panel.timezone` out of an already-loaded
 * settings list into the shape `setFormatting` (`datetime.ts`) accepts — each field taken from its
 * stored value where overridden, and its declared fallback otherwise.
 *
 * Shared by {@link applyPushedSettings} (which separately decides whether to call
 * `resetFormatting()` instead, when none of the three are overridden — see that function's doc
 * comment) and {@link panelFormatting} (which always wants a concrete value to hand to a Client
 * Component, and for which "fallback" and "built-in" are indistinguishable in practice since the
 * three fallbacks — `en-US`, `12h`, `system` — are exactly `datetime.ts`'s own built-ins).
 *
 * @param settings every setting, as returned by `listSettings`
 * @returns the locale, clock and timezone to format with
 */
function formattingFromSettings(settings: SettingValue[]): {
	locale: string;
	hour12: boolean;
	timeZone: string | undefined;
} {
	const locale = settings.find((setting) => setting.definition.key === "panel.locale");
	const timeFormat = settings.find((setting) => setting.definition.key === "panel.timeFormat");
	const timezone = settings.find((setting) => setting.definition.key === "panel.timezone");

	return {
		locale: (locale?.overridden ? locale.value : locale?.definition.fallback) as string,
		hour12: ((timeFormat?.overridden ? timeFormat.value : timeFormat?.definition.fallback) as string) === "12h",
		timeZone: resolveTimeZone((timezone?.overridden ? timezone.value : timezone?.definition.fallback) as string),
	};
}

/**
 * The panel's current locale, clock and timezone, resolved to what `datetime.ts`'s `setFormatting`
 * accepts.
 *
 * `applyPushedSettings` alone cannot make `panel.locale`/`panel.timeFormat`/`panel.timezone` reach
 * `formatDate`/`formatDateTime`'s actual callers: every one of them — `job-table.tsx`,
 * `log-stream.tsx`, `agent-card.tsx`, `asset-card.tsx`, `key-row.tsx` — is a Client Component, and
 * Next.js bundles Client Components into a module layer separate from the Server Component/Server
 * Action layer this module runs in, so `applyPushedSettings`'s push only ever reaches a
 * `datetime.ts` instance nothing in that layer reads. `app/(panel)/layout.tsx` calls this function
 * and hands the result to `FormatProvider` (`components/panel/format-provider.tsx`), a Client
 * Component whose own call to `setFormatting` lands in the instance that layer actually uses — see
 * that component's doc comment for the rest of the mechanism.
 *
 * @returns the locale, clock and timezone to format with
 */
export async function panelFormatting(): Promise<{ locale: string; hour12: boolean; timeZone: string | undefined }> {
	return formattingFromSettings(await listSettings());
}

/**
 * Resolves `panel.timezone`'s stored (or fallback) value to what `setFormatting` accepts.
 *
 * No membership check here: `panel.timezone` is `type: "enum"`, so `fits()` already refuses any
 * value outside {@link TIME_ZONES} at the store boundary — a value that reaches this function has
 * already been proven to be either `system` or a zone `Intl.supportedValuesOf` named at the moment
 * it was validated. The only translation left is `system`'s meaning: `setFormatting` takes
 * `undefined`, not the literal string, for "use the ambient zone".
 *
 * @param value the stored (or fallback) `panel.timezone` value
 * @returns the zone to format with, or `undefined` for the ambient system zone
 */
function resolveTimeZone(value: string): string | undefined {
	return value === "system" ? undefined : value;
}
