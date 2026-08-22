/**
 * Timestamp formatting for the panel.
 *
 * **The locale is pinned rather than taken from the runtime.** `toLocaleString()` with no argument
 * asks whatever is running the code what it prefers, and the answer differs on the two sides of a
 * server-rendered page: Node reports the host's system locale while the browser reports the user's.
 * A panel developed on a Finnish machine served `19.8.2026 klo 19.41.12` into HTML that the browser
 * then wanted to render as `8/19/2026, 7:41:12 PM`, and React threw out the whole tree and rebuilt
 * it on every page that showed a date.
 *
 * The components are spelled out rather than left to `dateStyle`/`timeStyle`, whose expansion is
 * locale data and so can move under an ICU upgrade — the same class of bug one level down.
 *
 * The locale, clock and timezone are now configurable (`panel.locale`, `panel.timeFormat`,
 * `panel.timezone`), but that does not reopen the hydration problem above: this module still never
 * asks the runtime what it prefers. `setFormatting` below is called by `applyPushedSettings`
 * (`settings-service.ts`) at startup and after every save, so the value is **server-pushed** —
 * both the server render and the browser hydration read the same module state, agreed in advance,
 * rather than each asking its own environment. That is the whole reason the push mechanism exists
 * for this module rather than an ordinary async settings read: `formatDateTime`/`formatDate` are
 * called synchronously during render and cannot await one.
 *
 * The timezone defaults to ambient — both sides resolve it to the machine's own zone, which is what
 * an operator wants to read, and the panel and the printers it drives are normally on one site. It
 * hydrates cleanly because server and browser agree on the zone. An operator working from another
 * one can now set `panel.timezone` explicitly rather than needing the honest-but-unbuilt fix of
 * formatting after mount.
 */

/** The module's own default locale: English, because the panel's copy is English. */
const BUILT_IN_LOCALE = "en-US";

/** The module's own default clock: 12-hour, matching {@link BUILT_IN_LOCALE}'s convention. */
const BUILT_IN_HOUR12 = true;

/**
 * The module's own default timezone: none, meaning `Intl` resolves the machine's own zone. This is
 * the "ambient" behaviour described in the module comment above.
 */
const BUILT_IN_TIME_ZONE: string | undefined = undefined;

/** Current locale, pushed by {@link setFormatting} or restored by {@link resetFormatting}. */
let locale: string = BUILT_IN_LOCALE;

/** Current clock, pushed by {@link setFormatting} or restored by {@link resetFormatting}. */
let hour12: boolean = BUILT_IN_HOUR12;

/** Current timezone, pushed by {@link setFormatting} or restored by {@link resetFormatting}. */
let timeZone: string | undefined = BUILT_IN_TIME_ZONE;

/**
 * Builds a date-and-time formatter from the module's current options.
 *
 * A function rather than a value assembled once: an `Intl.DateTimeFormat` captures its options at
 * construction, so honouring a pushed change means constructing a new instance, not mutating one.
 */
function buildDateTimeFormatter(): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat(locale, {
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
		hour12,
		...(timeZone === undefined ? {} : { timeZone }),
	});
}

/** Builds a date-alone formatter from the module's current options. See {@link buildDateTimeFormatter}. */
function buildDateFormatter(): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat(locale, {
		year: "numeric",
		month: "numeric",
		day: "numeric",
		...(timeZone === undefined ? {} : { timeZone }),
	});
}

// Built once at module load, then rebuilt in place by setFormatting/resetFormatting. A formatter
// per call is the expensive way to do this, and the Logs tab renders sixty of them in a list.
let DATE_TIME = buildDateTimeFormatter();
let DATE = buildDateFormatter();

/**
 * Pushes formatting options into this module, rebuilding both formatters against them.
 *
 * Called by `applyPushedSettings` (`settings-service.ts`) — see that function and the module
 * comment above for why a push rather than a read. `timeZone` is left ambient when omitted, the
 * same as this module's own built-in behaviour; callers pushing a validated `panel.timezone` value
 * pass it, and pass nothing for the `system` sentinel.
 *
 * **Rebuilds `DATE_TIME` and `DATE` rather than mutating an options object** — an `Intl.DateTimeFormat`
 * fixes its behaviour at construction, so a formatter built before this call keeps formatting with
 * the old options forever if this function only recorded the new ones.
 *
 * @param options the locale, clock and timezone to format with
 */
export function setFormatting(options: { locale: string; hour12: boolean; timeZone?: string }): void {
	locale = options.locale;
	hour12 = options.hour12;
	timeZone = options.timeZone;
	DATE_TIME = buildDateTimeFormatter();
	DATE = buildDateFormatter();
}

/**
 * Restores this module's built-in formatting, undoing whatever {@link setFormatting} last pushed.
 *
 * Mirrors `resetMinimumLevel` (`logger.ts`): "no stored override" and "do nothing" are not the same
 * instruction, so the settings store puts this module back to what it started at rather than
 * leaving it wherever the last push left it — see `applyPushedSettings` for when this is called.
 */
export function resetFormatting(): void {
	locale = BUILT_IN_LOCALE;
	hour12 = BUILT_IN_HOUR12;
	timeZone = BUILT_IN_TIME_ZONE;
	DATE_TIME = buildDateTimeFormatter();
	DATE = buildDateFormatter();
}

/** A date and a time, to the second: `8/19/2026, 7:41:12 PM`. */
export function formatDateTime(value: string | number | Date): string {
	return DATE_TIME.format(new Date(value));
}

/** A date alone: `8/19/2026`. For things whose time of day carries nothing. */
export function formatDate(value: string | number | Date): string {
	return DATE.format(new Date(value));
}
