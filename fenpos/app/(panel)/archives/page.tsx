import { listArchivePeriods } from "@/app/(panel)/archives/actions";
import { ArchiveTable } from "@/app/(panel)/archives/archive-table";
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
 * Opened by `logs:read`, which is also what the sidebar reveals it with. That is not the whole rule:
 * an audit period additionally needs `audit:read`, checked by `listArchivePeriods` before it offers
 * one and by `readArchivePage` before it opens one, so a caller here sees and reads only the sources
 * they hold.
 */
export default async function ArchivesPage() {
	// Outside any try: both an absent session and a refusal signal by throwing.
	await requirePagePermission("logs:read", "/archives");

	const periods = await listArchivePeriods();

	return <ArchiveTable periods={periods} />;
}
