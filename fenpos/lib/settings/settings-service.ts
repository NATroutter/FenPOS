import "server-only";
import { MINIMUM_PASSWORD_LENGTH, type PasswordPolicy } from "@/lib/auth/password-policy";
import { prisma } from "@/lib/db";
import { LogLevel } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";
import { resetFormatting, setFormatting } from "@/lib/format/datetime";
import { agentSettingsSchema, JOB_LIMITS, jobSettingsSchema, rawWriteSchema } from "@/lib/link/protocol";
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
 * The longest `auth.sessionHours` may be set to — thirty days.
 *
 * Exported because `lib/auth/auth.ts` needs the same number: Better Auth derives the session
 * cookie's `Max-Age` from `session.expiresIn`, a value read once at module load, and the browser
 * honours whichever of the cookie and the row expires first. Sizing `expiresIn` to this ceiling is
 * what keeps the cookie from ever being the shorter of the two, so the row this setting writes is
 * always the one that decides. A ceiling raised here and not there would silently cap the setting
 * again, which is exactly the bug the two references exist to prevent.
 */
export const MAXIMUM_SESSION_HOURS = 720;

/**
 * Which part of the system a setting affects.
 *
 * Declared per setting rather than derived from the key prefix, because the categories deliberately
 * span prefixes: `auth.*` and `pairing.*` are both security, and `link.*`, `events.*` and `agent.*`
 * are all connections. Deriving from the prefix would mean either a category per prefix — a dozen
 * nav entries — or renaming keys to suit the navigation, and a key is a stored contract.
 */
export type SettingCategory =
	| "general"
	| "limits"
	| "jobs"
	| "logs"
	| "media"
	| "variables"
	| "security"
	| "audit"
	| "connections"
	| "panel"
	| "statistics";

/**
 * A run of settings under one heading, within a category.
 *
 * Membership is listed here as keys rather than declared on each setting, so the whole information
 * architecture is one block somebody can read and argue with. The alternative — a `group` field on
 * all seventy-eight definitions — answers "which group is this in" at the cost of never being able
 * to answer "what is in this group" without reading the file end to end, and the second question is
 * the one somebody reorganising a tab is actually asking.
 *
 * `setting definitions` (settings-service.test.ts) holds the two halves together: every setting
 * appears in exactly one group, in the group list of the category it declares.
 */
export interface SettingGroup {
	/** The heading. Omitted from the screen when its category has only one group. */
	readonly label: string;
	readonly keys: readonly SettingKey[];
	/**
	 * Whether this group shows what the panel resolved the reader's own address to.
	 *
	 * A flag on the data rather than the form matching a label, because the form is a Client
	 * Component and this module is `server-only` — it can read a field off the props it is already
	 * given, but importing a constant from here would pull the guard into its bundle.
	 *
	 * The readout is what makes `server.trustedProxyHeaders` usable at all. Every other way of
	 * finding out whether it is right involves changing it, signing in again, reading the audit
	 * record and guessing.
	 */
	readonly showsClientAddress?: true;
}

/**
 * The categories in the order the panel lists them, each divided into headed groups.
 *
 * Only the categories with at least one setting appear here — an entry with nothing under it
 * would be a dead spot in the nav.
 *
 * **The groups exist because a category is not a small thing any more.** Security holds twenty
 * settings and Connections sixteen, and twenty controls in one undifferentiated grid is a list you
 * search rather than read: nothing on screen says that a password rule and a heartbeat timeout are
 * different kinds of decision, so every one of them has to be read to be ruled out. The headings
 * are the same argument the category rail already makes, one level further down.
 */
export const CATEGORIES: readonly {
	id: SettingCategory;
	title: string;
	summary: string;
	groups: readonly SettingGroup[];
}[] = [
	{
		id: "general",
		title: "General",
		summary: "How this install identifies itself.",
		groups: [{ label: "Identity", keys: ["server.publicUrl"] }],
	},
	{
		id: "limits",
		title: "Request limits",
		// No longer only print limits: the API's page sizes moved here from Security, where they had
		// never been a security control — nothing about how many rows come back in one response
		// decides who may ask. What stayed behind is `api.readsPerMinute`, which is a quota against
		// abuse and belongs with the other throttles.
		summary: "What one request may carry, and how much comes back.",
		groups: [
			{
				label: "Print requests",
				keys: ["limits.maxLines", "limits.maxLineChars", "limits.maxTotalChars", "limits.maxOutputLines"],
			},
			{ label: "API responses", keys: ["api.defaultPageSize", "api.maxPageSize"] },
		],
	},
	{
		id: "jobs",
		title: "Jobs",
		summary: "How much job history each agent keeps, and how a shutdown waits.",
		groups: [
			{
				label: "History kept",
				keys: ["jobs.retentionMinutes", "jobs.maxRecords", "jobs.maxErrorMessageChars"],
			},
			{ label: "Shutdown", keys: ["jobs.shutdownGraceSeconds"] },
		],
	},
	{
		id: "logs",
		title: "Logs",
		summary: "How much output is written and kept.",
		groups: [
			{
				label: "What is written",
				keys: ["logs.minimumLevel", "logs.maxMessageChars", "logs.recordApiReads", "logs.linesPerMinutePerAgent"],
			},
			{
				label: "Retention",
				keys: ["logs.retentionDays", "logs.archiveEnabled", "logs.archiveRetentionDays"],
			},
		],
	},
	{
		id: "media",
		title: "Images & assets",
		summary: "Uploads, and the images a job may fetch.",
		groups: [
			{
				label: "Stored images",
				keys: ["assets.maxUploadMb", "assets.acceptedFormats", "assets.rasterCacheMb"],
			},
			{
				// Split from the stored library because the two are different risks, not two halves of
				// one topic: an upload is bytes somebody here chose, and a remote reference is this
				// server making an outbound request on a caller's say-so.
				label: "Remote images",
				keys: [
					"images.maxRemoteReferences",
					"images.remoteFetchTimeoutMs",
					"images.allowPlainHttp",
					"images.allowedRemoteHosts",
				],
			},
		],
	},
	{
		id: "variables",
		title: "Variables",
		summary: "What `{name}` may resolve to, and how much of it one receipt may ask for.",
		groups: [
			{ label: "Availability", keys: ["variables.enabled", "variables.allowRequestValues"] },
			{
				label: "Limits",
				keys: ["variables.maxCount", "variables.maxValueChars", "variables.maxPerRequest", "variables.maxPerElement"],
			},
			// Named "printed" throughout, because the Panel tab carries the same two settings for the
			// screen and the pair being confusable is the whole reason both exist.
			{ label: "Printed formatting", keys: ["variables.timezone", "variables.locale"] },
		],
	},
	{
		id: "security",
		title: "Security",
		summary: "Passwords, sign-in, sessions, pairing, and what the API may be asked to do.",
		groups: [
			{
				// First, because almost everything below it keys on the answer: the sign-in throttle,
				// the address allowlist, and every address written to the audit record. Wrong here and
				// the throttle counts the wrong thing while the allowlist admits or refuses the wrong
				// people — which is why this group carries a live readout of what the panel currently
				// resolves the reader's own address to.
				label: "Client address",
				keys: ["server.trustedProxies", "server.trustedProxyHeaders", "server.proxyIpPriority"],
				showsClientAddress: true,
			},
			{
				label: "Passwords",
				keys: [
					"auth.minimumPasswordLength",
					"auth.requireMixedCase",
					"auth.requireDigit",
					"auth.requireSymbol",
					"auth.passwordReuseCount",
					"auth.passwordExpiryDays",
				],
			},
			{
				label: "Sign-in",
				keys: [
					"auth.require2fa",
					"auth.signInAttemptsPerMinute",
					"auth.lockoutAfterFailures",
					"auth.lockoutMinutes",
					"auth.ipAllowlist",
				],
			},
			{
				label: "Sessions",
				keys: [
					"auth.sessionHours",
					"auth.idleTimeoutMinutes",
					"auth.maxConcurrentSessions",
					"auth.lastSeenRefreshMinutes",
				],
			},
			{
				// Its own group rather than more of "Sign-in", because the three are one feature that is
				// configured together and is either wholly on or wholly off — and because the pair of
				// keys means nothing without the switch above them.
				label: "Bot challenge",
				keys: ["auth.turnstileEnabled", "auth.turnstileSiteKey", "auth.turnstileSecretKey"],
			},
			{ label: "Agent pairing", keys: ["pairing.enabled", "pairing.codeMinutes"] },
			{ label: "API access", keys: ["api.readsPerMinute"] },
			{
				// Its own heading despite being two settings, because it is the one switch here that
				// hands a caller the printer's own language with no content check in front of it.
				label: "Raw writes",
				keys: ["link.allowRawApiWrites", "link.maxRawWriteBytes"],
			},
		],
	},
	{
		id: "audit",
		title: "Audit",
		summary: "How much of the record is kept, and how much of it is written.",
		groups: [{ label: "The record", keys: ["audit.retentionDays", "audit.recordPageViews"] }],
	},
	{
		id: "connections",
		title: "Connections",
		summary: "The links to agents, to callers' webhooks, and to this panel.",
		groups: [
			{
				label: "Agent link",
				keys: [
					"link.heartbeatSeconds",
					"link.heartbeatTimeoutSeconds",
					"link.handshakeTimeoutSeconds",
					"link.commandTimeoutSeconds",
					"link.scanTimeoutSeconds",
					"link.statusIntervalSeconds",
				],
			},
			{ label: "Agent behaviour", keys: ["agent.evictionIntervalSeconds", "agent.queuePollMs"] },
			{
				label: "Webhooks",
				keys: [
					"webhooks.enabled",
					"webhooks.allowPlainHttp",
					"webhooks.timeoutMs",
					"webhooks.maxAttempts",
					"webhooks.retryBackoffSeconds",
					"webhooks.maxDeliveryRecords",
					"webhooks.deliverySweepEvery",
				],
			},
			{ label: "Panel live stream", keys: ["events.keepaliveSeconds"] },
		],
	},
	{
		id: "panel",
		title: "Panel",
		summary: "How this interface displays things.",
		groups: [
			{ label: "Page sizes", keys: ["panel.jobPageSize", "panel.logPageSize"] },
			{ label: "Dashboard", keys: ["panel.dashboardWindowHours", "panel.dashboardTailLines"] },
			{ label: "Display", keys: ["panel.locale", "panel.timeFormat", "panel.timezone"] },
		],
	},
	{
		id: "statistics",
		title: "Statistics",
		summary: "Whether usage is sampled and rolled up, and how long it is kept.",
		groups: [
			{
				label: "Collection",
				keys: [
					"stats.enabled",
					"stats.sampleIntervalSeconds",
					"stats.autoRefreshSeconds",
					"stats.sampleRetentionDays",
					"stats.apiMetrics",
				],
			},
		],
	},
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
	| (SettingBase & { type: "string"; maxLength: number; pattern?: RegExp; fallback: string })
	/**
	 * A credential this install holds on somebody else's behalf.
	 *
	 * Stored like a string and handled like nothing else in this file. **A secret's value never
	 * leaves the server**: {@link listSettings} substitutes the empty string for it, so the Settings
	 * page renders a box that says whether one is configured and never what it is, and
	 * {@link setSetting} redacts it from the line it logs. The audit row never carried values in the
	 * first place — see `saveSettings`, whose own comment anticipated this exact case.
	 *
	 * `fallback` is always the empty string, which is what "not configured" means: there is no
	 * sensible default for a credential, and a feature that needs one is off until it has one.
	 *
	 * **It is stored in plain text**, in the same SQLite file as everything else, because it has to
	 * be sent verbatim to the service it authenticates against — hashing it, as `api_keys` does with
	 * its own secrets, would make it useless. Anyone who can read the database file can read it. That
	 * is the same reach they already have over session tokens, so this adds a credential to that
	 * blast radius rather than widening it; the file's own permissions are what protect both.
	 */
	| (SettingBase & { type: "secret"; maxLength: number; fallback: "" })
	/**
	 * Several short values, stored as one comma-joined string.
	 *
	 * The storage is a plain string and always was — `"X-Forwarded-For"` and
	 * `"CF-Connecting-IP, X-Forwarded-For"` are the same rows they would have been as a `string`
	 * setting — so nothing migrates and a row written before this type existed still parses. What
	 * the type buys is that both ends stop guessing: `fits` checks each entry rather than the joined
	 * line, and the panel can offer entries as things you add and remove instead of punctuation you
	 * have to get right in a text box.
	 *
	 * `itemPattern` is a **source string**, not a `RegExp`, and deliberately: a `RegExp` cannot cross
	 * into a Client Component, which is the entire subject of {@link ClientSettingDefinition}. As a
	 * string it crosses safely, so the form can hold an entry to the same rule the server will.
	 */
	| (SettingBase & {
			type: "list";
			maxLength: number;
			itemPattern?: string;
			/**
			 * Entries offered as one-click additions under the box.
			 *
			 * For a setting whose valid values are a short, known set that nobody remembers the exact
			 * spelling of. `CF-Connecting-IP` typed as `CF-Connecting-Ip` is a header that matches
			 * nothing, and the failure is silent — so the ones worth having are worth offering rather
			 * than leaving to be recalled correctly.
			 *
			 * Not a closed set: the box still takes anything `itemPattern` allows, because a proxy
			 * this list has never heard of is a normal thing to be behind.
			 */
			suggestions?: readonly string[];
			fallback: string;
	  });

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
 * Reads the min and max a {@link jobSettingsSchema} or {@link agentSettingsSchema} field declares,
 * so a `jobs.*` or `agent.*` setting's bounds are derived rather than restated.
 *
 * The fields share one number in three places already — the relevant protocol.ts schema, the
 * agent's `FrameCodec` (`readJobSettings` / `readAgentSettings`), and (until this function existed)
 * a literal copy here — and a bound widened in `SETTINGS` without a matching widening in the schema
 * is exactly how `limits.maxOutputLines` used to fail: a setting the panel accepts that
 * `serialiseServerFrame` then refuses, caught only by `pushDeviceConfig`'s catch-and-log, so the
 * agent silently never receives the change. Deriving from the schema instead means widening it
 * there is the only edit these bounds ever need.
 *
 * `.minValue`/`.maxValue` type as `number | null` because a Zod number schema need not declare
 * either; every field these two schemas declare does, and `setting definitions`
 * (settings-service.test.ts) asserts as much, so the throw below is unreachable in practice rather
 * than a case this module has to recover from.
 *
 * @param field a field of {@link jobSettingsSchema} or {@link agentSettingsSchema}
 * @returns that field's declared bounds
 * @throws Error when the field declares no min or no max
 */
function jobBound(field: { minValue: number | null; maxValue: number | null }): { min: number; max: number } {
	if (field.minValue === null || field.maxValue === null) {
		throw new Error("schema field declares no bound to derive from");
	}
	return { min: field.minValue, max: field.maxValue };
}

/**
 * The most decoded bytes one `raw.write` frame can actually carry, derived from {@link rawWriteSchema}.
 *
 * The same failure class {@link jobBound} exists to prevent, one module over. `link.maxRawWriteBytes`
 * bounds the *decoded* bytes; the frame bounds the *base64 string* that carries them, and the agent's
 * `FrameCodec` (`MAX_RAW_CHARS`) mirrors that bound again. A `SETTINGS` maximum written as a literal
 * larger than the frame allows is a value the panel accepts and `serialiseServerFrame` then refuses —
 * and unlike `pushDeviceConfig`, the raw-write route has no catch-and-log for that: the ZodError is
 * not an `ApiError`, so the caller gets a 500, the reply slot leaks until `link.commandTimeoutSeconds`,
 * and the audit trail reads as a write of unknown outcome for bytes that provably never left. Deriving
 * the ceiling here means widening it in `protocol.ts` (and in the agent) is the only edit it needs.
 *
 * Base64 encodes three bytes as four characters, so a string of at most `maxLength` characters decodes
 * to at most `floor(maxLength / 4) * 3` bytes. Today that is 16384 characters, so 12288 bytes.
 *
 * `.maxLength` types as `number | null` because a Zod string schema need not declare one; this field
 * does, and `setting definitions` (settings-service.test.ts) walks every bound, so the throw is
 * unreachable in practice rather than a case this module has to recover from.
 *
 * @returns the largest decoded payload the link can carry
 * @throws Error when the frame's `bytes` field declares no maximum length
 */
function rawWriteByteCeiling(): number {
	const chars = rawWriteSchema.shape.bytes.maxLength;
	if (chars === null) {
		throw new Error("the raw.write frame declares no payload bound to derive from");
	}
	return Math.floor(chars / 4) * 3;
}

/** Keys of every setting. Persisted verbatim, so these strings are a stored contract. */
export const SETTING_KEYS = [
	"server.publicUrl",
	"server.trustedProxies",
	"server.trustedProxyHeaders",
	"server.proxyIpPriority",
	"limits.maxLines",
	"limits.maxLineChars",
	"limits.maxTotalChars",
	"limits.maxOutputLines",
	"jobs.retentionMinutes",
	"jobs.maxRecords",
	"jobs.shutdownGraceSeconds",
	"jobs.maxErrorMessageChars",
	"assets.maxUploadMb",
	"assets.acceptedFormats",
	"assets.rasterCacheMb",
	"images.maxRemoteReferences",
	"images.remoteFetchTimeoutMs",
	"images.allowPlainHttp",
	"images.allowedRemoteHosts",
	"variables.enabled",
	"variables.allowRequestValues",
	"variables.maxCount",
	"variables.maxValueChars",
	"variables.maxPerRequest",
	"variables.maxPerElement",
	"variables.timezone",
	"variables.locale",
	"logs.minimumLevel",
	"logs.linesPerMinutePerAgent",
	"logs.retentionDays",
	"logs.archiveEnabled",
	"logs.archiveRetentionDays",
	"logs.maxMessageChars",
	"logs.recordApiReads",
	"pairing.enabled",
	"pairing.codeMinutes",
	"auth.sessionHours",
	"auth.signInAttemptsPerMinute",
	"auth.minimumPasswordLength",
	"auth.lastSeenRefreshMinutes",
	"auth.requireMixedCase",
	"auth.requireDigit",
	"auth.requireSymbol",
	"auth.passwordReuseCount",
	"auth.passwordExpiryDays",
	"auth.lockoutAfterFailures",
	"auth.lockoutMinutes",
	"auth.ipAllowlist",
	"auth.require2fa",
	"auth.idleTimeoutMinutes",
	"auth.maxConcurrentSessions",
	"auth.turnstileEnabled",
	"auth.turnstileSiteKey",
	"auth.turnstileSecretKey",
	"audit.retentionDays",
	"audit.recordPageViews",
	"api.readsPerMinute",
	"api.defaultPageSize",
	"api.maxPageSize",
	"webhooks.enabled",
	"webhooks.allowPlainHttp",
	"webhooks.timeoutMs",
	"webhooks.maxAttempts",
	"webhooks.retryBackoffSeconds",
	"webhooks.maxDeliveryRecords",
	"webhooks.deliverySweepEvery",
	"events.keepaliveSeconds",
	"link.heartbeatSeconds",
	"link.heartbeatTimeoutSeconds",
	"link.handshakeTimeoutSeconds",
	"link.commandTimeoutSeconds",
	"link.scanTimeoutSeconds",
	"link.statusIntervalSeconds",
	"link.allowRawApiWrites",
	"link.maxRawWriteBytes",
	"agent.evictionIntervalSeconds",
	"agent.queuePollMs",
	"panel.jobPageSize",
	"panel.logPageSize",
	"panel.dashboardWindowHours",
	"panel.dashboardTailLines",
	"panel.locale",
	"panel.timeFormat",
	"panel.timezone",
	"stats.enabled",
	"stats.sampleIntervalSeconds",
	"stats.autoRefreshSeconds",
	"stats.sampleRetentionDays",
	"stats.apiMetrics",
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
		key: "server.trustedProxies",
		label: "Trusted proxies",
		description:
			"Which peers may name the caller through the headers below, as addresses or IPv4 ranges — typically your " +
			"reverse proxy, such as 127.0.0.1 or 172.16.0.0/12 for a container network. Empty is the default and means " +
			"no header is ever believed: the caller is whoever opened the connection. Set this only for addresses you " +
			"run, because anything listed here can choose its own identity for the sign-in throttle, the allowlist and " +
			"every audit row.",
		category: "security",
		type: "list",
		maxLength: 512,
		// An address, or an address with a prefix length. Deliberately not a hostname: this is compared
		// against a socket's peer address on every request, and a name would mean a lookup there.
		itemPattern: "^[0-9A-Fa-f.:]+(/\\d{1,3})?$",
		// Loopback covers the common single-host arrangement (nginx or Caddy in front, on the same
		// machine); the private ranges cover a container network. Offered, never applied by default.
		suggestions: ["127.0.0.1", "::1", "172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"],
		// Empty: an install reached directly must not believe a header its caller wrote, and there is
		// no way to tell from the request alone which install this is.
		fallback: "",
	},
	{
		key: "server.trustedProxyHeaders",
		label: "Trusted address headers",
		description:
			"Which request headers may say who the caller is, in the order they are tried — the first one present wins. " +
			"Behind Cloudflare and nginx together, use CF-Connecting-IP: X-Forwarded-For then ends at nginx's view of " +
			"Cloudflare rather than the visitor. Read only from the peers named above, so this list on its own changes " +
			"nothing. Anything listed here must be a header your proxy overwrites on every request, or a caller behind " +
			"it can simply send it themselves.",
		category: "security",
		type: "list",
		maxLength: 256,
		// A header name and nothing else, per entry. Keeps a pasted URL or an address out of a field
		// whose values are looked up as header names, where a wrong entry silently matches nothing.
		itemPattern: "^[A-Za-z0-9-]+$",
		// The headers a proxy in front of this actually sets, in rough order of how often. Offered
		// rather than left to memory because every one of them fails silently when misspelled: the
		// lookup simply misses and the caller resolves to the next header, or to unknown.
		suggestions: ["X-Forwarded-For", "CF-Connecting-IP", "X-Real-IP", "True-Client-IP", "Fly-Client-IP"],
		// What this file did unconditionally before the setting existed, so an install that upgrades
		// into it keeps the behaviour it already had rather than silently losing every address.
		fallback: "X-Forwarded-For",
	},
	{
		key: "server.proxyIpPriority",
		label: "Address to take from the list",
		description:
			"Which entry to use when a trusted header carries a list. Rightmost is the address the nearest proxy " +
			"actually observed and is the safe default: entries to its left were appended by whatever came before and " +
			"a caller can forge them. Leftmost is the original client and is only trustworthy when every hop between " +
			"is your own. Headers carrying a single address, such as CF-Connecting-IP, are unaffected by this.",
		category: "security",
		type: "enum",
		values: ["rightmost", "leftmost"],
		fallback: "rightmost",
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
		key: "jobs.maxErrorMessageChars",
		label: "Error message length",
		description: "Where a stored job error is truncated.",
		category: "jobs",
		type: "integer",
		min: 128,
		max: 4_000,
		fallback: 512,
		unit: "characters",
	},
	{
		key: "assets.maxUploadMb",
		label: "Maximum upload size",
		description:
			"Largest image accepted from a direct upload. An image fetched from a URL — whether imported to storage on the Assets tab or referenced live in a receipt — is also capped at a fixed 2 MiB by the fetch itself, regardless of this setting. The decode is bounded separately too, by a fixed pixel limit, so this is about storage rather than safety.",
		category: "media",
		type: "integer",
		min: 1,
		max: 512,
		fallback: 2,
		unit: "MiB",
	},
	{
		key: "assets.acceptedFormats",
		label: "Accepted image formats",
		description:
			"Which formats are accepted, uploaded or fetched — including a live URL a receipt names. JPEG is the more expensive decode; turning it off also means a receipt naming a JPEG by URL fails to compile at all, not just that one image.",
		category: "media",
		type: "enum",
		values: ["png+jpeg", "png"] as const,
		fallback: "png+jpeg",
	},
	{
		key: "assets.rasterCacheMb",
		label: "Raster cache size",
		description:
			"Memory held for dithered images, so a repeated print does not re-dither. Raise it on a busy install with many assets; lower it on a small machine.",
		category: "media",
		type: "integer",
		min: 1,
		max: 128,
		fallback: 8,
		unit: "MiB",
	},
	{
		key: "images.maxRemoteReferences",
		label: "Remote images per job",
		description:
			"Distinct URLs one job may fetch. Set it to 0 to switch off images fetched by URL from a receipt — importing an asset from a URL on the Assets tab is unaffected.",
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
		key: "variables.enabled",
		label: "Enable variables",
		description:
			"Whether `{name}` in markup is replaced by a configured value. Switched off, a brace is ordinary text and every receipt prints exactly as it did before this feature existed — which is the reason to switch it off: turning variables on changes what existing markup means, because a slug-shaped `{something}` that used to print goes to failing as an unknown variable. The Variables section leaves the sidebar while this is off; what it holds is kept.",
		category: "variables",
		type: "boolean",
		fallback: true,
	},
	{
		key: "variables.allowRequestValues",
		label: "Allow values from print requests",
		description:
			"Whether a print request may carry its own `variables` object. Switched off, only values configured here and per-printer overrides are used, and a request sending the field is refused. An install whose receipts should be entirely under this panel's control turns it off.",
		category: "variables",
		type: "boolean",
		fallback: true,
	},
	{
		key: "variables.maxCount",
		label: "Variables kept",
		description:
			"How many variables may be defined. Reached only by an install using them for something they are not for.",
		category: "variables",
		type: "integer",
		min: 1,
		max: 5_000,
		fallback: 200,
		unit: "variables",
	},
	{
		key: "variables.maxValueChars",
		label: "Value length",
		description:
			"Longest value a variable may hold, whether configured here, overridden on a printer, or supplied with a print request. This is what bounds how far one short line of markup can expand.",
		category: "variables",
		type: "integer",
		min: 1,
		max: 4_096,
		fallback: 200,
		unit: "characters",
	},
	{
		key: "variables.maxPerRequest",
		label: "Values per request",
		description: "How many names one print request's `variables` object may carry.",
		category: "variables",
		type: "integer",
		min: 0,
		max: 500,
		fallback: 50,
		unit: "values",
	},
	{
		key: "variables.maxPerElement",
		label: "References per line",
		description:
			"How many `{name}` references one element of `data` may contain. Bounds expansion where it happens, rather than leaving the printed-lines limit to catch the result after the work is done.",
		category: "variables",
		type: "integer",
		min: 1,
		max: 1_000,
		fallback: 100,
		unit: "references",
	},
	{
		key: "variables.timezone",
		label: "Printed time zone",
		description:
			"Which zone date and time variables are formatted in. Separate from the panel's own zone on purpose: that one is a display preference for whoever is looking at this screen, while this is what gets printed on paper, possibly at a site in another country. `system` uses the server's own zone.",
		category: "variables",
		type: "enum",
		values: TIME_ZONES,
		fallback: "system",
	},
	{
		key: "variables.locale",
		label: "Printed date format",
		description:
			"Which locale's month and day names date variables are written with, for a pattern containing `MMMM` or `EEEE`. Patterns made only of numbers are unaffected, so an install printing dates as digits can leave this alone.",
		category: "variables",
		type: "enum",
		values: ["en-US", "en-GB", "fi-FI", "sv-SE", "de-DE", "fr-FR"] as const,
		fallback: "en-US",
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
		key: "logs.retentionDays",
		label: "Log retention",
		description:
			"How long a log line is kept before it is removed. Bounded by time rather than by a record count, so a " +
			"noisy afternoon cannot evict the week before it. When archiving is on, whole calendar months are " +
			"kept, so up to a month more than this is retained.",
		category: "logs",
		type: "integer",
		min: 1,
		max: 3_650,
		fallback: 30,
		unit: "days",
	},
	{
		key: "logs.archiveEnabled",
		label: "Archive log lines",
		description:
			"Whether log lines leaving the retention window are written to a compressed archive first. With " +
			"this off they are deleted outright. With it on, retention works a whole calendar month at a " +
			"time, so up to a month more than the window is kept — an archive's name has to be true.",
		category: "logs",
		type: "boolean",
		fallback: true,
	},
	{
		key: "logs.archiveRetentionDays",
		label: "Log archive retention",
		description:
			"How long a log archive is kept before it is deleted. Measured from the end of the month it " +
			"covers, and the whole month has to have aged past this window before the file goes, so up to " +
			"a month more than this is kept — the same rounding the log retention setting above carries, " +
			"and for the same reason: an archive is named for a calendar month. Bounds what archiving can " +
			"cost in disk; the audit record's archives are not deleted on a timer and have no equivalent " +
			"setting.",
		category: "logs",
		type: "integer",
		min: 1,
		max: 3_650,
		fallback: 365,
		unit: "days",
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
		key: "logs.recordApiReads",
		label: "Record successful API reads",
		description:
			"Whether a successful read is written to the API request log, not only one that was refused. A till " +
			"polling status once a second produces 86,400 rows a day, and five tills over thirty days is about " +
			"3.9 GB, which is why this defaults off. A refused read is recorded regardless of this setting: what " +
			"it gates is noise, never evidence.",
		category: "logs",
		type: "boolean",
		fallback: false,
	},
	{
		key: "pairing.enabled",
		label: "Allow pairing",
		description:
			"Whether new agents may pair. Switch it off once every agent is paired — the endpoint then refuses every code, including valid ones.",
		category: "security",
		type: "boolean",
		fallback: true,
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
			"How long a session lasts before it must be signed in again. Read when a session is created, so a " +
			"change takes effect at the next sign-in rather than the next restart. The clock starts at sign-in " +
			"and is not extended by use. A shared back-office terminal wants hours; a private office wants days.",
		category: "security",
		type: "integer",
		min: 1,
		max: MAXIMUM_SESSION_HOURS,
		fallback: 12,
		unit: "hours",
	},
	{
		key: "auth.signInAttemptsPerMinute",
		label: "Sign-in attempts per minute",
		description:
			"Failed sign-ins allowed before the panel refuses to try. The ceiling is the built-in value — this can be tightened, never loosened.",
		category: "security",
		type: "integer",
		min: 3,
		max: 5,
		fallback: 5,
		unit: "attempts/min",
	},
	{
		key: "auth.minimumPasswordLength",
		label: "Minimum password length",
		description:
			"Shortest acceptable account password. The floor is the built-in value — this can be raised, never lowered. Existing passwords are unaffected until they are changed. First-run setup enforces only the built-in floor, not this setting, since there is no account yet to have configured it.",
		category: "security",
		type: "integer",
		min: MINIMUM_PASSWORD_LENGTH,
		max: 128,
		fallback: MINIMUM_PASSWORD_LENGTH,
		unit: "characters",
	},
	{
		key: "auth.lastSeenRefreshMinutes",
		label: "Session activity refresh",
		description:
			"How stale a session's last-seen time may get before it is written again. The inactivity timeout " +
			"measures against it and the per-account session limit orders by it, so this exists only to bound " +
			"how often a busy panel writes to the session row — it is a write-rate control, not a security " +
			"setting. Setting it at or above the inactivity timeout would have sessions judged idle on a time " +
			"that had not been refreshed yet, so it is capped at half the timeout when one is set.",
		category: "security",
		type: "integer",
		min: 1,
		max: 120,
		fallback: 5,
		unit: "minutes",
	},
	{
		key: "auth.requireMixedCase",
		label: "Require mixed case",
		description:
			"Whether a password must contain both an upper-case and a lower-case letter. Off by default: composition rules push people toward Password1! and away from the long passphrases that are actually stronger.",
		category: "security",
		type: "boolean",
		fallback: false,
	},
	{
		key: "auth.requireDigit",
		label: "Require a digit",
		description: "Whether a password must contain a digit. Off by default, for the reason mixed case is.",
		category: "security",
		type: "boolean",
		fallback: false,
	},
	{
		key: "auth.requireSymbol",
		label: "Require a symbol",
		description:
			"Whether a password must contain a character that is neither a letter nor a digit. A space does not count — spaces are what make a passphrase readable.",
		category: "security",
		type: "boolean",
		fallback: false,
	},
	{
		key: "auth.passwordReuseCount",
		label: "Passwords remembered",
		description:
			"How many of an account's previous passwords it may not return to. Zero remembers none. Each one costs a hash verification when a password is changed, which is why this is not unbounded.",
		category: "security",
		type: "integer",
		min: 0,
		max: 24,
		fallback: 0,
		unit: "passwords",
	},
	{
		key: "auth.passwordExpiryDays",
		label: "Password lifetime",
		description:
			"How long a password may go unchanged before the account is required to replace it. Zero never expires — which current guidance prefers, since forced rotation mostly produces the same password with a rising number on the end.",
		category: "security",
		type: "integer",
		min: 0,
		max: 3_650,
		fallback: 0,
		unit: "days",
	},
	{
		key: "auth.lockoutAfterFailures",
		label: "Lock out after",
		description:
			"Consecutive failed sign-ins before an account is locked. Zero never locks this way. It is a " +
			"per-account limit on the password step, separate from the per-address throttle above, which stays " +
			"on regardless: one defends a password, the other defends the server. An account with an " +
			"authenticator also carries a second, built-in lock that this setting does not govern — ten " +
			"consecutive wrong codes lock it for fifteen minutes, whatever this is set to.",
		category: "security",
		type: "integer",
		min: 0,
		max: 100,
		// On by default, and generously, at a count no human reaches by mistyping. Off was the earlier
		// default, on the reasoning that a lockout is a denial-of-service primitive handed to anyone who
		// knows an email address. That is true and it is still the smaller risk: off left the per-address
		// throttle as the only guard on password guessing, and a throttle keyed on an address is only
		// ever as good as the answer to "whose address" — somebody sharing a NAT with the victim spends
		// the victim's budget rather than their own. Ten is a second line that does not depend on that
		// question having been answered correctly.
		fallback: 10,
		unit: "attempts",
	},
	{
		key: "auth.lockoutMinutes",
		label: "Lockout duration",
		description: "How long a locked account stays locked. It clears itself; nobody has to unlock it.",
		category: "security",
		type: "integer",
		min: 1,
		max: 1_440,
		fallback: 15,
		unit: "minutes",
	},
	{
		key: "auth.ipAllowlist",
		label: "Address allowlist",
		description:
			"Addresses and CIDR ranges that may sign in, separated by commas or newlines. Empty allows every address. Checked at sign-in and again on every panel request, so tightening it ends sessions that no longer qualify. Set this wrongly and nobody can sign in.",
		category: "security",
		type: "string",
		maxLength: 2_000,
		fallback: "",
	},
	{
		key: "auth.require2fa",
		label: "Require two-factor",
		description:
			"Whether every account must carry an authenticator app before it can reach the panel. Turning this on " +
			"does not lock anyone out: an account with no enrolment still signs in and is sent to set one up, " +
			"because a switch that stranded the only administrator would have no remedy until the recovery CLI " +
			"exists.",
		category: "security",
		type: "boolean",
		fallback: false,
	},
	{
		key: "auth.idleTimeoutMinutes",
		label: "Inactivity timeout",
		description:
			"How long a session may sit untouched before it is ended. Zero never ends one for inactivity, which is " +
			"the default — a panel on a wall display is meant to sit still. A shop floor terminal in a public room " +
			"is the case for setting it.",
		category: "security",
		type: "integer",
		min: 0,
		max: 1440,
		fallback: 0,
		unit: "minutes",
	},
	{
		key: "auth.maxConcurrentSessions",
		label: "Sessions per account",
		description:
			"How many places one account may be signed in at once. Reaching the limit ends the least recently used " +
			"session rather than refusing the new one: an operator whose browser crashed must be able to get back " +
			"in, and refusing them would turn a stale row into an outage. Zero is unlimited.",
		category: "security",
		type: "integer",
		min: 0,
		max: 50,
		fallback: 0,
		unit: "sessions",
	},
	{
		key: "auth.turnstileEnabled",
		label: "Require a bot challenge",
		description:
			"Whether the sign-in page runs a Cloudflare Turnstile challenge before the password is checked. It stands " +
			"in front of the password rather than replacing anything: an attacker who solves it still needs the " +
			"credential. Off until both keys below are filled in — a challenge switched on with no keys would refuse " +
			"every sign-in, including the one that would switch it back off.",
		category: "security",
		type: "boolean",
		fallback: false,
	},
	{
		key: "auth.turnstileSiteKey",
		label: "Turnstile site key",
		description:
			"The public half of the pair, from the Turnstile section of the Cloudflare dashboard. It is embedded in " +
			"the sign-in page and is meant to be visible; it identifies the widget rather than authenticating anything.",
		category: "security",
		type: "string",
		// No pattern. Cloudflare's keys are `0x` followed by a fixed run of characters today, and a
		// check written to that shape is a check that refuses a good key the day the shape changes.
		maxLength: 128,
		fallback: "",
	},
	{
		key: "auth.turnstileSecretKey",
		label: "Turnstile secret key",
		description:
			"The private half of the pair. Used once per sign-in, from this server, to ask Cloudflare whether the " +
			"challenge was really solved. It is never shown again after it is saved and never leaves this server.",
		category: "security",
		type: "secret",
		maxLength: 128,
		fallback: "",
	},
	{
		key: "audit.retentionDays",
		label: "Audit retention",
		description:
			"How long an audit event is kept in the live database. Events past the window are archived a whole " +
			"calendar month at a time and are never deleted unarchived, so up to a month more than this is retained. " +
			"Sweeping runs oldest-first and re-anchors the chain behind itself, so what survives stays verifiable; " +
			"the only other way history leaves this record is an archived month deleted by hand on the Archives tab.",
		category: "audit",
		type: "integer",
		min: 1,
		max: 3_650,
		fallback: 365,
		unit: "days",
	},
	{
		key: "audit.recordPageViews",
		label: "Record page views",
		description:
			"Whether opening a panel page writes an audit event. Off by default: a live tab re-renders on every job or log event, not only when somebody navigates, so this records far more than it reads like it would.",
		category: "audit",
		type: "boolean",
		fallback: false,
	},
	{
		key: "api.readsPerMinute",
		label: "API reads per minute",
		description:
			"How many listing and status requests one API key may make each minute. Printing is not counted: a receipt already costs a compile and a device round trip, and throttling a till is an operator's decision rather than a default.",
		category: "security",
		type: "integer",
		min: 1,
		max: 10_000,
		fallback: 120,
		unit: "requests",
	},
	{
		key: "api.defaultPageSize",
		label: "API page size",
		description: "How many records a listing endpoint returns when the caller does not ask for a number.",
		// Moved out of `security`, where it had never belonged: how many rows come back in one
		// response decides nothing about who may ask for them. `api.readsPerMinute` stayed behind,
		// because a quota against abuse is a different kind of number from a page size.
		category: "limits",
		type: "integer",
		min: 1,
		max: 1_000,
		fallback: 50,
		unit: "records",
	},
	{
		key: "api.maxPageSize",
		label: "Largest API page",
		description:
			"The most records one listing request may ask for. A caller naming a larger number gets this instead of an error, so a client written against a looser install still works here.",
		// With `api.defaultPageSize`, and for the same reason.
		category: "limits",
		type: "integer",
		min: 1,
		max: 1_000,
		fallback: 200,
		unit: "records",
	},
	{
		key: "webhooks.enabled",
		label: "Deliver webhooks",
		description:
			"Whether job outcomes are delivered to registered webhook URLs. Switch it off to stop every delivery at once without unregistering anything.",
		category: "connections",
		type: "boolean",
		fallback: true,
	},
	{
		key: "webhooks.allowPlainHttp",
		label: "Allow plain http webhooks",
		description:
			"Whether a webhook may be delivered over http as well as https. A delivery carries job identifiers and error text, and its signature proves who sent it but does not hide it.",
		category: "connections",
		type: "boolean",
		fallback: false,
	},
	{
		key: "webhooks.timeoutMs",
		label: "Webhook timeout",
		description: "How long one delivery attempt may take before it counts as failed and is retried.",
		category: "connections",
		type: "integer",
		min: 250,
		max: 30_000,
		fallback: 5_000,
		unit: "ms",
	},
	{
		key: "webhooks.maxAttempts",
		label: "Webhook attempts",
		description: "How many times one delivery is tried before it is given up on and recorded as failed.",
		category: "connections",
		type: "integer",
		min: 1,
		max: 20,
		fallback: 5,
		unit: "attempts",
	},
	{
		key: "webhooks.retryBackoffSeconds",
		label: "Webhook retry delay",
		description:
			"The wait before the second attempt. Each further attempt doubles it, so a receiver that is down for a while is not hammered while it recovers.",
		category: "connections",
		type: "integer",
		min: 1,
		max: 3_600,
		fallback: 10,
		unit: "s",
	},
	{
		key: "webhooks.maxDeliveryRecords",
		label: "Delivery records kept",
		description:
			"Hard cap on settled (delivered or failed) deliveries kept, sweeping the oldest first. A delivery still pending or being retried is never swept.",
		category: "connections",
		type: "integer",
		min: 100,
		max: 1_000_000,
		fallback: 10_000,
		unit: "records",
	},
	{
		key: "webhooks.deliverySweepEvery",
		label: "Delivery sweep interval",
		description: "How many settled deliveries pass between retention sweeps. Lower is tidier, higher is cheaper.",
		category: "connections",
		type: "integer",
		min: 10,
		max: 5_000,
		fallback: 50,
		unit: "records",
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
		key: "link.statusIntervalSeconds",
		label: "Device status interval",
		description:
			"How often an agent reports device state when nothing has changed. Lower it on a site where a reconnecting printer reads as offline for too long. Pushed to every agent.",
		category: "connections",
		type: "integer",
		...jobBound(agentSettingsSchema.shape.statusIntervalSeconds),
		fallback: 30,
		unit: "seconds",
	},
	{
		key: "link.allowRawApiWrites",
		label: "Allow raw API writes",
		description:
			"Whether a key holding 'devices:raw' may send raw ESC/POS bytes to a printer. Off by default: raw bytes bypass every content limit, codepage check and width calculation, and this server cannot report what such a write printed. Leave it off unless an integration genuinely needs it.",
		category: "security",
		type: "boolean",
		fallback: false,
	},
	{
		key: "link.maxRawWriteBytes",
		label: "Largest raw write",
		description:
			"The most bytes one raw write may carry. This is the only bound on a raw write; none of the print limits apply to one, so it is what stops a single request occupying a printer indefinitely. The ceiling is what one link frame can carry, so a write that passes here always fits on the wire.",
		category: "security",
		type: "integer",
		min: 1,
		// Derived, not restated: a bound above what the frame carries is a value the panel accepts and
		// the link then refuses. See {@link rawWriteByteCeiling}.
		max: rawWriteByteCeiling(),
		fallback: 8_192,
		unit: "bytes",
	},
	{
		key: "agent.evictionIntervalSeconds",
		label: "Agent janitor interval",
		description: "How often an agent sweeps its own expired job records.",
		category: "connections",
		type: "integer",
		...jobBound(agentSettingsSchema.shape.evictionIntervalSeconds),
		fallback: 60,
		unit: "seconds",
	},
	{
		key: "agent.queuePollMs",
		label: "Print queue poll",
		description: "How often an idle print queue checks for work. Lower is more responsive, higher is less idle CPU.",
		category: "connections",
		type: "integer",
		...jobBound(agentSettingsSchema.shape.queuePollMs),
		fallback: 100,
		unit: "ms",
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
	{
		key: "stats.enabled",
		label: "Collect statistics",
		description:
			"Master switch. When off, nothing samples, counts or rolls up, and the Statistics section leaves the sidebar until it is turned back on.",
		category: "statistics",
		type: "boolean",
		fallback: true,
	},
	{
		key: "stats.sampleIntervalSeconds",
		label: "Fleet sample interval",
		description: "How often the fleet sampler takes a snapshot of every agent and printer's state.",
		category: "statistics",
		type: "integer",
		min: 60,
		max: 3_600,
		fallback: 300,
		unit: "seconds",
	},
	{
		key: "stats.autoRefreshSeconds",
		label: "Auto-refresh",
		description:
			"How often the Statistics page's live cards and current bucket redraw while the tab is visible. Zero turns auto-refresh off.",
		category: "statistics",
		type: "integer",
		min: 0,
		max: 600,
		fallback: 30,
		unit: "seconds",
	},
	{
		key: "stats.sampleRetentionDays",
		label: "Sample retention",
		description:
			"How long a fleet sample is kept before it is pruned. Hourly rollups are unaffected and are kept forever.",
		category: "statistics",
		type: "integer",
		min: 30,
		max: 3_650,
		fallback: 400,
		unit: "days",
	},
	{
		key: "stats.apiMetrics",
		label: "Count API requests",
		description:
			"Whether API requests are counted toward the Statistics page's API tab. Off stops the counting, not the requests themselves.",
		category: "statistics",
		type: "boolean",
		fallback: true,
	},
];

/** A setting's current value, and whether it is stored or the built-in default. */
export interface SettingValue {
	definition: SettingDefinition;
	/**
	 * The current value — **except for a `secret`, which always reads as the empty string.**
	 *
	 * See {@link listSettings}. `overridden` is what says whether one is configured; the value
	 * itself is never handed out by this function at all. Use {@link secretSetting} on the server
	 * when the credential is actually needed.
	 */
	value: number | string | boolean;
	/** False when no row exists, so the panel can say the default is in effect. */
	overridden: boolean;
}

/**
 * Reads every setting, filling in defaults where nothing is stored.
 *
 * **A `secret` setting's value is not returned.** This function feeds the Settings page, whose props
 * cross into a Client Component and therefore into the browser, so a credential returned here would
 * be readable in the page source by anyone holding `settings:read` — a permission granted for seeing
 * how the install is configured, which is not the same thing as holding its credentials. The empty
 * string is substituted and `overridden` carries the only fact the screen needs: whether one is set.
 *
 * That is deliberately enforced here rather than at the page, so a second caller cannot leak what
 * this one does not.
 *
 * @returns each setting with its current value, secrets excepted
 */
export async function listSettings(): Promise<SettingValue[]> {
	const rows = await prisma.setting.findMany({ where: { key: { in: [...SETTING_KEYS] } } });
	const stored = new Map(rows.map((row) => [row.key, row.value]));

	return SETTINGS.map((definition) => {
		const parsed = parseStored(stored.get(definition.key));
		const usable = parsed !== undefined && fits(definition, parsed);

		if (definition.type === "secret") {
			// `overridden` means "a credential is stored", so an empty stored string reads as unset —
			// which is what it is. Clearing the box and saving is how a credential is removed.
			return { definition, value: "", overridden: usable && parsed !== "" };
		}

		return {
			definition,
			value: usable ? parsed : definition.fallback,
			overridden: usable,
		};
	});
}

/**
 * Reads one `secret` setting's actual value.
 *
 * The counterpart to {@link listSettings}'s refusal to return one: this is the single way a secret
 * is read back, and it is `server-only` by this module's own first line. Callers are the code that
 * has to present the credential to whoever issued it.
 *
 * @param key which secret
 * @returns the stored credential, or the empty string when none is configured
 * @throws Error when the key names a setting that is not a secret
 */
export async function secretSetting(key: SettingKey): Promise<string> {
	const definition = SETTINGS.find((setting) => setting.key === key);
	if (definition?.type !== "secret") {
		throw new Error(`'${key}' is not a secret setting.`);
	}

	const row = await prisma.setting.findUnique({ where: { key } });
	const parsed = parseStored(row?.value);
	return typeof parsed === "string" && fits(definition, parsed) ? parsed : "";
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
		case "secret":
			// No pattern. A credential's shape belongs to whoever issues it, and a check here would
			// come to refuse a perfectly good key the day that format changed.
			return typeof value === "string" && value.length <= definition.maxLength;
		case "list": {
			if (typeof value !== "string" || value.length > definition.maxLength) {
				return false;
			}
			if (definition.itemPattern === undefined) {
				return true;
			}
			// Checked per entry rather than against the joined line, which is the point of the type:
			// a pattern written for the whole string has to describe the separators too, and every
			// such pattern this file had was really a per-entry rule with comma handling bolted on.
			const item = new RegExp(definition.itemPattern);
			return parseList(value).every((entry) => item.test(entry));
		}
	}
}

/**
 * Splits a `list` setting into its entries.
 *
 * Commas and newlines both separate, matching what `ip-allowlist.ts` already accepts: an operator
 * pasting a list from anywhere will use one or the other, and neither is worth refusing. Blanks are
 * dropped, so a trailing comma is not an empty entry.
 *
 * @param raw the setting as stored
 * @returns the entries, trimmed, in order
 */
export function parseList(raw: string): string[] {
	return raw
		.split(/[,\n]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
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

/** Agent-side timing knobs as configured, in the shape `config.sync`'s `agent` field carries. */
export interface GlobalAgentSettings {
	statusIntervalSeconds: number;
	evictionIntervalSeconds: number;
	queuePollMs: number;
}

/**
 * Reads the agent-side timing settings pushed to every agent.
 *
 * Separate from {@link globalJobSettings} for the same reason that one is separate from
 * {@link globalLimits}: these three govern the agent's own schedules — status reporting, job
 * eviction, print queue polling — rather than a job's retention or its shutdown grace, even though
 * both objects cross on the same `config.sync` frame.
 *
 * @returns the agent timing settings in effect install-wide
 */
export async function globalAgentSettings(): Promise<GlobalAgentSettings> {
	const settings = await listSettings();
	// Every key named below is declared `type: "integer"`, asserted by the test that walks
	// SETTINGS. A mismatch here is a definition that changed type without its readers being
	// updated, which is a programming error rather than a stored value.
	const value = (key: SettingKey): number => narrow(settings, key, "integer") as number;

	return {
		statusIntervalSeconds: value("link.statusIntervalSeconds"),
		evictionIntervalSeconds: value("agent.evictionIntervalSeconds"),
		queuePollMs: value("agent.queuePollMs"),
	};
}

/** The `logs.*` limits as configured, in the shape `lib/logs/ingest.ts` and the maintenance pass read. */
export interface GlobalLogIngestSettings {
	linesPerMinutePerAgent: number;
	/** `logs.retentionDays`: how long a line is kept before it is swept. */
	retentionDays: number;
	/** `logs.archiveEnabled`: whether a swept line is archived first, rather than only deleted. */
	archiveEnabled: boolean;
	/** `logs.archiveRetentionDays`: how long a log archive is kept before it is deleted. */
	archiveRetentionDays: number;
	maxMessageChars: number;
}

/**
 * Reads the log ingestion settings as one object, honouring overrides.
 *
 * Separate from {@link globalLimits} and {@link globalJobSettings} because these go to a third
 * place: the per-line log ingest path (`lib/logs/ingest.ts`), which caches the result rather than
 * calling this for every line — the same reason `globalLimits`/`globalJobSettings` read once per
 * group instead of once per setting, applied one level up. `lib/maintenance/pass.ts` reads the same
 * object for the retention half of it, hourly, where the cost of a read is nothing.
 *
 * @returns the log ingestion settings in effect install-wide
 */
export async function globalLogIngestSettings(): Promise<GlobalLogIngestSettings> {
	const settings = await listSettings();
	// Every key named below is declared `type: "integer"`, asserted by the test that walks
	// SETTINGS. A mismatch here is a definition that changed type without its readers being
	// updated, which is a programming error rather than a stored value.
	const value = (key: SettingKey): number => narrow(settings, key, "integer") as number;
	// `logs.archiveEnabled` is the one `boolean` among these, asserted the same way.
	const flag = (key: SettingKey): boolean => narrow(settings, key, "boolean") as boolean;

	return {
		linesPerMinutePerAgent: value("logs.linesPerMinutePerAgent"),
		retentionDays: value("logs.retentionDays"),
		archiveEnabled: flag("logs.archiveEnabled"),
		archiveRetentionDays: value("logs.archiveRetentionDays"),
		maxMessageChars: value("logs.maxMessageChars"),
	};
}

/** Who may name the caller, through which headers, and which entry of a list to believe. */
export interface GlobalProxyTrust {
	/** Peer addresses and IPv4 ranges whose headers are believed. Empty trusts no peer. */
	proxies: string[];
	/** Header names in the order they are tried, lowercased for lookup. Empty trusts nothing. */
	headers: string[];
	/** Which entry to take from a header carrying a list. */
	priority: "rightmost" | "leftmost";
}

/**
 * How the caller's address is to be derived.
 *
 * One read for all three settings, the same shape as {@link globalLimits} and
 * {@link globalSignInPolicy} and for the same reason: this is on the path of every audited action
 * and every sign-in, and three separate accessors would be three queries where one does.
 *
 * @returns the peers to trust, the headers to read from them, and which entry of a list to take
 */
export async function globalProxyTrust(): Promise<GlobalProxyTrust> {
	const settings = await listSettings();
	const proxies = narrow(settings, "server.trustedProxies", "list") as string;
	const raw = narrow(settings, "server.trustedProxyHeaders", "list") as string;
	const priority = narrow(settings, "server.proxyIpPriority", "enum") as string;

	return {
		proxies: parseList(proxies),
		// Lowercased because both `Headers` and Node's `IncomingMessage.headers` key on the lowercase
		// name, and an operator typing the conventional `X-Forwarded-For` must not miss because of it.
		headers: parseList(raw).map((name) => name.toLowerCase()),
		priority: priority === "leftmost" ? "leftmost" : "rightmost",
	};
}

/**
 * The password policy in force, as `passwordSchema` wants it.
 *
 * `minimumLength` is floored at `MINIMUM_PASSWORD_LENGTH` rather than trusted from storage: the
 * setting's own `min` enforces it on write, and this makes a row written before that bound existed —
 * or edited around it — unable to weaken the floor `setup.ts` relies on.
 *
 * @returns the policy in force install-wide
 */
export async function globalPasswordPolicy(): Promise<PasswordPolicy> {
	const settings = await listSettings();
	const flag = (key: SettingKey): boolean => narrow(settings, key, "boolean") as boolean;

	return {
		minimumLength: Math.max(
			MINIMUM_PASSWORD_LENGTH,
			narrow(settings, "auth.minimumPasswordLength", "integer") as number,
		),
		requireMixedCase: flag("auth.requireMixedCase"),
		requireDigit: flag("auth.requireDigit"),
		requireSymbol: flag("auth.requireSymbol"),
	};
}

/** What governs whether a sign-in attempt may proceed at all, before any credential is examined. */
export interface GlobalSignInPolicy {
	/**
	 * `auth.lockoutAfterFailures`: consecutive password failures before an account locks. Zero never
	 * locks *this* way; the two-factor plugin's own account lockout is separate and always on.
	 */
	lockoutAfterFailures: number;
	/** `auth.lockoutMinutes`: how long a lock lasts. */
	lockoutMinutes: number;
	/** `auth.ipAllowlist`: raw, as stored. Empty allows every address. */
	ipAllowlist: string;
}

/**
 * The sign-in gates, read as one object.
 *
 * One call because both gates run on the same path, in the same request, before any credential is
 * examined — and two `listSettings()` reads where one would do is a round trip on the hot path of the
 * one endpoint an attacker is deliberately hammering.
 *
 * @returns the lockout and allowlist settings in force
 */
export async function globalSignInPolicy(): Promise<GlobalSignInPolicy> {
	const settings = await listSettings();
	return {
		lockoutAfterFailures: narrow(settings, "auth.lockoutAfterFailures", "integer") as number,
		lockoutMinutes: narrow(settings, "auth.lockoutMinutes", "integer") as number,
		ipAllowlist: narrow(settings, "auth.ipAllowlist", "string") as string,
	};
}

/**
 * How long a password lasts and how many are remembered.
 *
 * Separate from {@link globalPasswordPolicy} because these two govern a password's *history* rather
 * than its *shape*, and they are read on different paths: the shape wherever a password is validated,
 * the history only where one is changed or a session is resumed.
 *
 * @returns the reuse and expiry settings in force
 */
export async function globalPasswordLifetime(): Promise<{ reuseCount: number; expiryDays: number }> {
	const settings = await listSettings();
	return {
		reuseCount: narrow(settings, "auth.passwordReuseCount", "integer") as number,
		expiryDays: narrow(settings, "auth.passwordExpiryDays", "integer") as number,
	};
}

/** The session shape an install has configured, in the units the code that enforces it uses. */
export interface GlobalSessionPolicy {
	/** `auth.sessionHours` as seconds. How long a session created now will last. */
	sessionSeconds: number;
	/** `auth.idleTimeoutMinutes` as milliseconds. Zero never ends a session for inactivity. */
	idleTimeoutMs: number;
	/**
	 * `auth.lastSeenRefreshMinutes` as milliseconds. How stale `Session.lastSeenAt` may get before it
	 * is rewritten, before `session-policy.ts` clamps it against the inactivity timeout.
	 */
	lastSeenRefreshMs: number;
	/** `auth.maxConcurrentSessions`. Zero is unlimited. */
	maxConcurrentSessions: number;
}

/**
 * How long a session lasts, how quiet it may go, and how many an account may hold.
 *
 * One call because the session gate reads all of them on the same request, and because the three
 * are only meaningful together — an inactivity timeout longer than the session lifetime never
 * fires, and a refresh interval longer than the inactivity timeout would judge a session idle on a
 * timestamp it had not got round to rewriting.
 *
 * Converted here rather than at each call site. Every one of these is stored in the unit an
 * operator thinks in and used in the unit a clock comparison needs, and a missed multiplication is
 * the kind of defect that shows up as "sessions last four seconds" in production and nowhere else.
 *
 * @returns the session settings in force
 */
export async function globalSessionPolicy(): Promise<GlobalSessionPolicy> {
	const settings = await listSettings();
	const minutes = (key: SettingKey): number => (narrow(settings, key, "integer") as number) * 60 * 1000;
	return {
		sessionSeconds: (narrow(settings, "auth.sessionHours", "integer") as number) * 60 * 60,
		idleTimeoutMs: minutes("auth.idleTimeoutMinutes"),
		lastSeenRefreshMs: minutes("auth.lastSeenRefreshMinutes"),
		maxConcurrentSessions: narrow(settings, "auth.maxConcurrentSessions", "integer") as number,
	};
}

/** The `audit.*` settings as one object, in the shape `lib/audit/` reads them. */
export interface GlobalAuditSettings {
	/** `audit.retentionDays`: how long an event is kept before it is swept. */
	retentionDays: number;
	/** `audit.recordPageViews`: whether opening a panel page writes a row. */
	recordPageViews: boolean;
}

/**
 * Reads the audit settings as one object, honouring overrides.
 *
 * One call rather than two, for the same reason {@link globalLogIngestSettings} exists: its callers
 * want a group of settings at once, and two `listSettings()` reads where one would do is a round
 * trip spent on nothing. `audit.recordPageViews` is read per authenticated page render
 * (`lib/auth/require-permission.ts`), which is what makes that worth saying at all.
 *
 * @returns the audit settings in effect install-wide
 */
export async function globalAuditSettings(): Promise<GlobalAuditSettings> {
	const settings = await listSettings();
	// Every key named below is declared with the type it is narrowed to here, asserted by the test
	// that walks SETTINGS. A mismatch is a definition that changed type without its readers.
	const integer = (key: SettingKey): number => narrow(settings, key, "integer") as number;

	return {
		retentionDays: integer("audit.retentionDays"),
		recordPageViews: narrow(settings, "audit.recordPageViews", "boolean") as boolean,
	};
}

/** The `stats.*` settings as one object, in the shape the metrics rollup and sampler read them. */
export interface GlobalStatsSettings {
	/** `stats.enabled`: master switch. Off stops sampling, counting and rolling up alike. */
	enabled: boolean;
	/** `stats.sampleIntervalSeconds`: how often the fleet sampler takes a snapshot. */
	sampleIntervalSeconds: number;
	/** `stats.autoRefreshSeconds`: how often the Statistics page redraws itself. Zero is off. */
	autoRefreshSeconds: number;
	/** `stats.sampleRetentionDays`: how long a fleet sample is kept before it is pruned. */
	sampleRetentionDays: number;
	/** `stats.apiMetrics`: whether API requests are counted. */
	apiMetrics: boolean;
}

/**
 * Reads the statistics settings as one object, honouring overrides.
 *
 * One call rather than five, for the same reason {@link globalAuditSettings} exists: the maintenance
 * pass and the fleet sampler each want every one of these at once.
 *
 * @returns the statistics settings in effect install-wide
 */
export async function globalStatsSettings(): Promise<GlobalStatsSettings> {
	const [enabled, sampleIntervalSeconds, autoRefreshSeconds, sampleRetentionDays, apiMetrics] = await Promise.all([
		booleanSetting("stats.enabled"),
		integerSetting("stats.sampleIntervalSeconds"),
		integerSetting("stats.autoRefreshSeconds"),
		integerSetting("stats.sampleRetentionDays"),
		booleanSetting("stats.apiMetrics"),
	]);

	return { enabled, sampleIntervalSeconds, autoRefreshSeconds, sampleRetentionDays, apiMetrics };
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

	// A secret's new value is not logged. Server logs are the one channel that routinely leaves the
	// machine — forwarded, tailed over a shoulder, pasted into a ticket — and the audit row already
	// records that this key changed without saying to what.
	logger.info("Setting changed", { key, value: definition.type === "secret" ? "[redacted]" : value });
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
		case "secret":
			return `must be text of at most ${definition.maxLength} characters`;
		case "list":
			return `must be a list of at most ${definition.maxLength} characters in total`;
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
 * Everything `app/(panel)/layout.tsx` needs from settings, read once rather than twice.
 *
 * That layout renders on every panel navigation (`export const dynamic = "force-dynamic"`), so a
 * second `listSettings()` call there — one for `auth.minimumPasswordLength`, a second inside
 * {@link panelFormatting} — doubles a 43-key query already paid on every page in the panel. Same
 * shape as {@link globalLimits}: read once, narrow several values out of it.
 *
 * @returns `auth.minimumPasswordLength`'s current value, and what {@link panelFormatting} would
 *          have derived from the same read
 */
export async function panelLayoutSettings(): Promise<{
	minimumPasswordLength: number;
	formatting: { locale: string; hour12: boolean; timeZone: string | undefined };
}> {
	const settings = await listSettings();
	return {
		minimumPasswordLength: narrow(settings, "auth.minimumPasswordLength", "integer") as number,
		formatting: formattingFromSettings(settings),
	};
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
