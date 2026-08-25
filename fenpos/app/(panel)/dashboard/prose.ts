/**
 * The small pieces of text the Dashboard composes from a configured setting.
 *
 * Split from `page.tsx` because `page.tsx` is a React server component and this project's
 * vitest config deliberately excludes React (`include: ["test/**\/*.test.ts"]`, `vitest.config.mts`)
 * — a plain `.ts` module is what stays testable.
 */

/**
 * One of the Dashboard's two headline labels — `Printed (24h)` and `Failed (24h)` — phrased for
 * the configured `panel.dashboardWindowHours`.
 *
 * Extracted for the same reason `signInThrottlePhrase` (`lib/auth/rate-limit.ts`) and
 * `minimumLengthPhrase` (`lib/auth/password-policy.ts`) were: this project has broken exactly this
 * kind of sentence at a boundary three times already — "0 MB", "1 distinct URLs", "1 hours" — and
 * a hardcoded `${WINDOW_HOURS}h` was itself already one boundary bug waiting to happen the day
 * this setting became configurable. Unlike those three, the count here never changes the unit's
 * spelling — "h" takes no plural — but the rule is to extract and pin down every sentence built
 * from a configured value, not only the ones known in advance to need it.
 *
 * @param heading "Printed" or "Failed" — the word the count follows
 * @param windowHours the configured `panel.dashboardWindowHours`
 * @returns e.g. "Printed (24h)" or, at the setting's minimum, "Printed (1h)"
 */
export function dashboardStatLabel(heading: string, windowHours: number): string {
	return `${heading} (${windowHours}h)`;
}
