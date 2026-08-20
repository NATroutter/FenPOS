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
 * The timezone is still ambient, and deliberately: both sides resolve it to the machine's own zone,
 * which is what an operator wants to read, and the panel and the printers it drives are normally on
 * one site. It hydrates cleanly because server and browser agree on the zone. They would not for an
 * operator working from another one, and the honest fix there is to format after mount rather than
 * during render — worth doing when someone actually needs it, not before.
 */

/** en-US because the panel's copy is English; any fixed locale would hydrate. */
const LOCALE = "en-US";

// Built once. A formatter per call is the expensive way to do this, and the Logs tab renders sixty
// of them in a list.
const DATE_TIME = new Intl.DateTimeFormat(LOCALE, {
	year: "numeric",
	month: "numeric",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	second: "2-digit",
	hour12: true,
});

const DATE = new Intl.DateTimeFormat(LOCALE, {
	year: "numeric",
	month: "numeric",
	day: "numeric",
});

/** A date and a time, to the second: `8/19/2026, 7:41:12 PM`. */
export function formatDateTime(value: string | number | Date): string {
	return DATE_TIME.format(new Date(value));
}

/** A date alone: `8/19/2026`. For things whose time of day carries nothing. */
export function formatDate(value: string | number | Date): string {
	return DATE.format(new Date(value));
}
