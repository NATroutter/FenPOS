/**
 * Names the archive period a moment belongs to.
 *
 * UTC rather than the host's zone, deliberately. `compose.yaml` sets `TZ` for user-facing job and
 * log timestamps, but an archive filename that moved when a deployment changed zone would make two
 * files claim the same month and neither hold all of it.
 *
 * @param at the moment to place
 * @returns the period key, e.g. `2026-07`
 */
export function periodKeyFor(at: Date): string {
	return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}
