/**
 * Filters that can hold more than one value: how they travel in a URL, and what they become in a
 * `where`.
 *
 * The panel's three filtered tables — Jobs, Logs, Audit — all narrow by the same shape of thing: a
 * column, and the values an operator is interested in. "Show me the failed jobs" and "show me the
 * failed and cancelled jobs" are the same question asked about one value and two, and a filter that
 * only answers the first makes the second into three page loads and a mental note.
 *
 * Both halves live here because they have to agree. {@link joinValues} decides what a URL holds,
 * {@link parseValues} reads it back, and {@link anyOf} turns the result into a Prisma fragment; a
 * separator chosen in one place and assumed in another is how a filter comes to work everywhere
 * except the one column whose ids contain the character nobody checked.
 */

/**
 * What separates several values in one query parameter.
 *
 * A comma in one parameter rather than the same parameter repeated. Repeating it is the more usual
 * URL idiom, but it makes `searchParams` hand a page `string | string[]` for every filter, and every
 * `Object.entries(params)` that builds a paging link would have to learn the difference. Nothing
 * this filters by can contain a comma: the values are cuids, action identifiers like `users:create`,
 * and closed enums.
 */
const SEPARATOR = ",";

/**
 * Reads a query parameter that may hold several values.
 *
 * @param value the parameter as it arrived, or undefined when it is absent
 * @returns the values, empty when there is no filter
 */
export function parseValues(value: string | undefined): string[] {
	if (!value) {
		return [];
	}
	return value.split(SEPARATOR).filter((entry) => entry !== "");
}

/**
 * Reads a query parameter that may hold several values, keeping only the ones this version knows.
 *
 * The unknown ones are dropped rather than erroring, which is the same reading the single-value
 * filters already took: a bookmark saved before a status was renamed should still list rows, and a
 * value the dropdown has no label for would otherwise sit in the trigger unreadable.
 *
 * @param value the parameter as it arrived
 * @param known a guard naming what this version still recognises
 * @returns the recognised values, empty when none survive
 */
export function parseKnownValues<T extends string>(
	value: string | undefined,
	known: (candidate: string) => candidate is T,
): T[] {
	return parseValues(value).filter(known);
}

/**
 * Writes several values back into one query parameter.
 *
 * @param values the values to carry
 * @returns the parameter's value, or null when there is nothing to filter by
 */
export function joinValues(values: string[]): string | null {
	return values.length === 0 ? null : values.join(SEPARATOR);
}

/**
 * Turns "this value, or any of these" into a Prisma fragment.
 *
 * Undefined for anything that is not a filter — no value, an empty list, an empty string — because
 * "the operator picked nothing" means every row, not no rows. That is the reading the single-value
 * filters had when they tested the value for truthiness, and it is the one that makes unticking the
 * last option in a dropdown put the table back rather than empty it.
 *
 * A single value still comes out as `equals` rather than a one-element `in`. Both are correct; the
 * first is what the query planner was already given for these columns, and the tests that pass one
 * value are asserting about the same query they always were.
 *
 * @param value one value, several, or none
 * @returns the fragment to spread into a `where`, or undefined when there is nothing to narrow by
 */
export function anyOf<T extends string | number>(
	value: T | readonly T[] | undefined,
): { equals: T } | { in: T[] } | undefined {
	if (value === undefined) {
		return undefined;
	}
	const list = (Array.isArray(value) ? [...(value as readonly T[])] : [value as T]).filter((entry) => entry !== "");
	if (list.length === 0) {
		return undefined;
	}
	return list.length === 1 ? { equals: list[0] } : { in: list };
}

/**
 * Reads how many rows to step over, from a value that crossed the wire.
 *
 * `offset` is not a filter's value — it never appears in a URL and it is never multi-valued — but
 * every infinite-scroll action reads it across the same boundary its filters cross, and it needs the
 * same scepticism: a server action is a public endpoint, and a caller can post anything. Clamped to a
 * whole number at or above zero rather than handed straight to Prisma's `skip`, which rejects a
 * fractional or negative bound outright. Mirrors `archives/actions.ts`'s own `pageOf`, which clamps
 * its `skip` the same way for the same reason.
 *
 * @param value whatever the caller sent
 * @returns a safe offset to skip by
 */
export function parseOffset(value: unknown): number {
	const parsed = Math.trunc(Number(value));
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
