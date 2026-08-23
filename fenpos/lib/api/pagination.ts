import { ApiError } from "@/lib/errors";
import { integerSetting } from "@/lib/settings/settings-service";

/**
 * Query parsing and cursor derivation shared by every paginated API listing.
 *
 * Cursor rather than offset, and not as a matter of taste. Rows in a listing like this can vanish
 * between requests — a job cascades away with the device or agent that owned it, for instance — and
 * a caller paging with `skip` over a shrinking list walks past rows it has never seen, because the
 * page boundary moves under it. A cursor names a record instead of a position, so a row deleted
 * behind the caller costs them nothing.
 */

/**
 * Reads `limit` and `cursor` from a listing request.
 *
 * A `limit` above the configured ceiling is clamped rather than refused, on the grounds that a
 * client written against a more permissive install should keep working here — one page at a time —
 * rather than failing on a number it did not choose. A `limit` that is not a positive whole number
 * is refused, because that is a bug in the client rather than a difference of configuration.
 *
 * @param url the request URL
 * @returns how many records to fetch, and where to resume from
 * @throws ApiError `invalid_query` when `limit` is present and not a positive whole number
 */
export async function readPageParams(url: URL): Promise<{ take: number; cursor: string | null }> {
	const [fallback, ceiling] = await Promise.all([
		integerSetting("api.defaultPageSize"),
		integerSetting("api.maxPageSize"),
	]);

	const raw = url.searchParams.get("limit");
	if (raw === null) {
		return { take: Math.min(fallback, ceiling), cursor: url.searchParams.get("cursor") };
	}

	// `Number` rather than `parseInt`: `parseInt("10abc")` is 10, which would silently accept a
	// limit the caller did not write.
	const asked = Number(raw);
	if (!Number.isInteger(asked) || asked < 1) {
		throw new ApiError("invalid_query", "'limit' must be a whole number of at least 1.", { limit: raw });
	}

	return { take: Math.min(asked, ceiling), cursor: url.searchParams.get("cursor") };
}

/**
 * Splits an over-fetched result into a page and the cursor that continues it.
 *
 * The caller fetches `take + 1` rows; the extra one is never returned and exists only to answer
 * "are there more" without a second count query, which on a busy install is a scan run on every
 * page view to produce one boolean. `listJobs` in `lib/jobs/job-service.ts` uses the same trick for
 * the panel.
 *
 * @param rows the fetched rows, of which one more than `take` was asked for
 * @param take the page size the caller asked for
 * @returns the page to return, and the cursor to resume from, or null at the end of the list
 */
export function pageOf<T extends { id: string }>(rows: T[], take: number): { page: T[]; nextCursor: string | null } {
	const page = rows.slice(0, take);
	return {
		page,
		nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
	};
}
