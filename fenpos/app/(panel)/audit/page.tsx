import { Archive } from "lucide-react";
import Link from "next/link";
import { auditArchiveCovering } from "@/app/(panel)/audit/actions";
import { AuditList } from "@/app/(panel)/audit/audit-list";
import { ChainBanner } from "@/app/(panel)/audit/chain-banner";
import { parseAuditSearchParams } from "@/app/(panel)/audit/search-params";
import { Filters } from "@/app/(panel)/jobs/filters";
import { buttonVariants } from "@/components/ui/button";
import { auditFilterOptions, listAuditEvents } from "@/lib/audit/audit-query";
import { userHolds } from "@/lib/auth/effective-permissions";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { AuditOutcome } from "@/lib/domain/audit";

export const metadata = { title: "Audit record" };

/** Never cached: the newest row is usually the one somebody came here to read. */
export const dynamic = "force-dynamic";

/**
 * The signpost's own styling, and the Logs tab's exactly — one rule, kept identical, because the two
 * banners answer the same question about two records and an operator should not have to learn them
 * separately. Muted and unalarmed: nothing has gone wrong here, the record is exactly where retention
 * put it, so this must not read as a warning.
 */
const SIGNPOST =
	"flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 p-3 text-muted-foreground";

/**
 * The Audit tab.
 *
 * Who did what, and what came of it. There is no delete control and no edit control **on this page**,
 * because there is no delete path and no edit path behind it: `recordAudit` is the only writer,
 * retention is the only remover of live rows, and neither is reachable from here. The one way a person
 * removes audit history from the panel at all is deleting an archived month on the Archives tab, under
 * `audit:archive-delete` — which is deliberately somewhere else, gated by a permission of its own, and
 * writes its own row into the record it shortens.
 *
 * **This tab shows the live window, and says so when a range reaches past it.** Retention moves whole
 * months out of `audit.db` into the archive directory rather than deleting them, so a filter reaching
 * back far enough returns a short page or an empty one — and an empty table over rows that are sitting
 * in an `audit-*.db.gz` is the "the data is somewhere nobody told you to look" failure that archiving
 * was supposed to remove rather than relocate. `auditArchiveCovering` decides whether there is anything
 * to point at, and the banner is not rendered at all when there is not. The Logs tab carries the same
 * affordance, from `archiveCovering`, under `logs:read`.
 *
 * Filters and sort live in the URL, so a view can be bookmarked and sent to somebody else — which on
 * this table is most of what it is for.
 *
 * **Scrolls rather than pages.** The server component below still renders one page-size worth of
 * events and `AuditList` appends further batches as the operator scrolls, through
 * `listMoreAuditEvents`. A stale bookmark carrying `?skip=` from before this feature is simply
 * ignored: this page reads no such parameter, so it renders the first page exactly as any other
 * visit would.
 */
export default async function AuditPage({
	searchParams,
}: {
	searchParams: Promise<{
		actor?: string;
		action?: string;
		outcome?: string;
		target?: string;
		from?: string;
		to?: string;
		sort?: string;
		dir?: string;
	}>;
}) {
	// Outside any try: both an absent session and a refusal signal by throwing.
	const user = await requirePagePermission("audit:read", "/audit");

	const params = await searchParams;
	const { actorIds, actions, outcomes, targetIds, sort, desc, from, to } = parseAuditSearchParams(params);
	// Either end alone is a range: "everything since March" and "everything up to March" both narrow the
	// view, and both can reach back past the live window.
	const ranged = from !== undefined || to !== undefined;

	const [options, page, canVerify, canExport, covering] = await Promise.all([
		auditFilterOptions(),
		listAuditEvents({
			actorUserId: actorIds,
			action: actions,
			outcome: outcomes,
			targetId: targetIds,
			from,
			to,
			sort,
			desc,
		}),
		userHolds(user, "audit:verify"),
		userHolds(user, "audit:export"),
		// Only when a range has actually been asked for. An unfiltered tab is not asking about a stretch
		// of history, so the oldest archive on disk would appear under every default page load — a
		// signpost that is always there is scenery, and stops being read long before it matters.
		ranged ? auditArchiveCovering({ from, to }) : null,
	]);

	return (
		<div className="flex flex-col gap-5">
			<ChainBanner
				canVerify={canVerify}
				canExport={canExport}
				filter={{
					actorUserId: params.actor,
					action: params.action,
					outcome: params.outcome,
					targetId: params.target,
					from: params.from,
					to: params.to,
				}}
			/>

			<Filters
				filters={[
					{
						name: "actor",
						label: "Actor",
						values: actorIds,
						options: options.actors.map((actor) => ({ value: actor.id, label: actor.label })),
					},
					{
						name: "action",
						label: "Action",
						values: actions,
						options: options.actions.map((action) => ({ value: action, label: action })),
					},
					{
						name: "outcome",
						label: "Outcome",
						values: outcomes,
						options: AuditOutcome.values.map((value) => ({ value, label: value.toLowerCase() })),
					},
				]}
				range={{ from: params.from ?? "", to: params.to ?? "" }}
			/>

			{/* Above the table, not under it: it is the reason the table is short, and an operator who has
			    to scroll past an empty one to find out where the rest went has already had the experience
			    this banner exists to prevent. */}
			{covering === null ? null : (
				<div className={SIGNPOST}>
					<Archive className="size-4 shrink-0" />
					<p className="min-w-0 flex-1 text-[12px]">
						This range reaches back before the live window. The events from {covering} left this table when that period
						aged out, and are in the archive for it.
					</p>
					{/* A link wearing a button's clothes, not a Base UI Button rendering an anchor: that
					    component announces itself as a button, and this navigates. `buttonVariants` is
					    exported for exactly this. */}
					<Link href="/archives" className={buttonVariants({ variant: "outline", size: "sm" })}>
						Open the archives
					</Link>
				</div>
			)}

			<AuditList
				// Remounts on a real filter or sort change, so scroll history from one query is never
				// reconciled against another's — see `components/panel/infinite-scroll.tsx`.
				key={JSON.stringify({
					actorIds,
					actions,
					outcomes,
					targetIds,
					sort,
					desc,
					from: from?.toISOString(),
					to: to?.toISOString(),
				})}
				initial={{ rows: page.events, more: page.more }}
				query={{
					actor: params.actor,
					action: params.action,
					outcome: params.outcome,
					target: params.target,
					from: params.from,
					to: params.to,
					sort: params.sort,
					dir: params.dir,
				}}
			/>
		</div>
	);
}
