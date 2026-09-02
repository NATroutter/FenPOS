import { listArchivePeriods } from "@/app/(panel)/archives/actions";
import { ArchiveTable } from "@/app/(panel)/archives/archive-table";
import { ARCHIVE_PERMISSIONS } from "@/app/(panel)/tab-permits";
import { permitsFor } from "@/lib/auth/permits";
import { requirePagePermission } from "@/lib/auth/require-permission";

export const metadata = { title: "Archives" };

/** Never cached: a period appears here the hour it is rotated out, without anything asking this page. */
export const dynamic = "force-dynamic";

/**
 * The Archives tab.
 *
 * The other end of retention. A period that ages out of `logs.db` or `audit.db` is not deleted, it is
 * moved into a compressed file — and until this page existed, the operator's failure was not "the
 * data is gone" but "the data is somewhere nobody told you to look".
 *
 * **This page lists; it does not read.** The listing is a directory scan and a size per file. Opening
 * a period decompresses a whole month before it can answer anything, which on a busy install is the
 * most expensive read the panel can do — so it happens when somebody picks a period, in
 * `archive-table.tsx`, and never here. A page that opened every archive to render itself would be the
 * exact cost this split exists to avoid.
 *
 * Opened by **either** `logs:read` or `audit:read`, matching the sidebar entry: this tab lists both
 * kinds of archived period, so an account holding one of them has something to read here. Requiring
 * one named permission would send the other's holder to `/no-access` — and for an auditor that is the
 * page telling them the record is gone by refusing to load. What each caller may actually see is
 * settled per period further in, by the two actions.
 */
export default async function ArchivesPage() {
	// Outside any try: both an absent session and a refusal signal by throwing.
	const user = await requirePagePermission(["logs:read", "audit:read"], "/archives");

	const [listing, permits] = await Promise.all([
		listArchivePeriods(),
		// Resolved here because a client component cannot read the database. Convenience only — the
		// action is refused again by its own gate; see `permitsFor`.
		permitsFor(user, ARCHIVE_PERMISSIONS),
	]);

	return <ArchiveTable periods={listing.periods} error={listing.error} canDelete={permits["audit:archive-delete"]} />;
}
