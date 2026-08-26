import Link from "next/link";
import { AuditFilters } from "@/app/(panel)/audit/audit-filters";
import { AuditTable } from "@/app/(panel)/audit/audit-table";
import { ChainBanner } from "@/app/(panel)/audit/chain-banner";
import { Button } from "@/components/ui/button";
import { auditFilterOptions, listAuditEvents } from "@/lib/audit/audit-query";
import { isAuditSortColumn } from "@/lib/audit/audit-sort";
import { userHolds } from "@/lib/auth/effective-permissions";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { AuditOutcome } from "@/lib/domain/audit";

export const metadata = { title: "Audit record" };

/** Never cached: the newest row is usually the one somebody came here to read. */
export const dynamic = "force-dynamic";

/** How many rows one page shows. Mirrors `listAuditEvents`'s own default, for the paging arithmetic. */
const PAGE_SIZE = 50;

/**
 * The Audit tab.
 *
 * Who did what, and what came of it. There is no delete control and no edit control on this page,
 * because there is no delete path and no edit path behind it: `recordAudit` is the only writer,
 * retention is the only remover, and neither is reachable from here.
 *
 * Filters and sort live in the URL, so a view can be bookmarked and sent to somebody else — which on
 * this table is most of what it is for.
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
		skip?: string;
		sort?: string;
		dir?: string;
	}>;
}) {
	// Outside any try: both an absent session and a refusal signal by throwing.
	const user = await requirePagePermission("audit:read", "/audit");

	const params = await searchParams;
	const skip = Math.max(0, Number.parseInt(params.skip ?? "0", 10) || 0);
	// An unknown value falls back rather than erroring: a bookmark saved before a column was renamed
	// should still list events.
	const outcome = params.outcome && AuditOutcome.is(params.outcome) ? params.outcome : undefined;
	const sort = params.sort && isAuditSortColumn(params.sort) ? params.sort : undefined;
	const desc = params.dir ? params.dir !== "asc" : undefined;
	const from = parseDay(params.from, "start");
	const to = parseDay(params.to, "end");

	const [options, page, canVerify, canExport] = await Promise.all([
		auditFilterOptions(),
		listAuditEvents({
			actorUserId: params.actor,
			action: params.action,
			outcome,
			targetId: params.target,
			from,
			to,
			skip,
			sort,
			desc,
			take: PAGE_SIZE,
		}),
		userHolds(user, "audit:verify"),
		userHolds(user, "audit:export"),
	]);

	const query = (next: Record<string, string | undefined>): string => {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries({ ...params, ...next })) {
			if (value) {
				search.set(key, value);
			}
		}
		const rendered = search.toString();
		return rendered ? `?${rendered}` : "?";
	};

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

			<AuditFilters
				actors={options.actors.map((actor) => ({ value: actor.id, label: actor.label }))}
				actions={options.actions.map((action) => ({ value: action, label: action }))}
				outcomes={AuditOutcome.values.map((value) => ({ value, label: value.toLowerCase() }))}
				selected={{
					actor: params.actor ?? null,
					action: params.action ?? null,
					outcome: outcome ?? null,
					from: params.from ?? "",
					to: params.to ?? "",
				}}
			/>

			<AuditTable events={page.events} />

			{skip > 0 || page.more ? (
				<div className="flex items-center gap-2">
					{skip > 0 ? (
						<Button
							variant="outline"
							size="sm"
							render={<Link href={query({ skip: String(Math.max(0, skip - PAGE_SIZE)) })} />}
						>
							Newer
						</Button>
					) : null}
					{page.more ? (
						<Button variant="outline" size="sm" render={<Link href={query({ skip: String(skip + PAGE_SIZE) })} />}>
							Older
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * Turns a `yyyy-mm-dd` from a date input into a bound on an instant.
 *
 * The end of the day rather than its start for the upper bound, because an operator who types today's
 * date into "To" means today inclusive — a literal reading would exclude everything that happened
 * after midnight, which is everything.
 *
 * @param value the input's value, or undefined
 * @param edge which end of the day to take
 * @returns the bound, or undefined when there is nothing to bound by
 */
function parseDay(value: string | undefined, edge: "start" | "end"): Date | undefined {
	if (!value) {
		return undefined;
	}
	const at = new Date(edge === "start" ? `${value}T00:00:00.000` : `${value}T23:59:59.999`);
	return Number.isNaN(at.getTime()) ? undefined : at;
}
