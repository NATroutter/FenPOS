"use server";

import { type AuditSearchParams, parseAuditSearchParams } from "@/app/(panel)/audit/search-params";
import { periodKeyFor } from "@/lib/archive/period";
import { listArchives } from "@/lib/archive/read";
import { toAuditCsv } from "@/lib/audit/audit-csv";
import { type AuditEventSummary, type AuditFilter, listAuditEvents } from "@/lib/audit/audit-query";
import { readEpoch } from "@/lib/audit/epoch";
import { describeVerification, verifyAuditChain } from "@/lib/audit/verify";
import { panelQuery } from "@/lib/auth/panel-action";
import { REFUSAL_MESSAGE } from "@/lib/auth/require-permission";
import { auditDb } from "@/lib/db";
import { AuditOutcome } from "@/lib/domain/audit";
import { ApiError } from "@/lib/errors";
import { archiveDirectory } from "@/lib/maintenance/pass";
import { parseOffset, parseValues } from "@/lib/table/multi-filter";

/**
 * Server actions behind the Audit tab.
 *
 * All three are reads. There is no create, no edit and no delete **here**, and there never will be:
 * the record has one writer (`lib/audit/audit-log.ts`) and one deleter of live rows
 * (`lib/audit/retention.ts`), and neither is reachable from this tab. The one way a person removes
 * audit history from the panel is deleting an archived month on the Archives tab, under
 * `audit:archive-delete` — `deleteAuditArchive` in `app/(panel)/archives/actions.ts`, which is
 * deliberately not one of these and deliberately not on this page.
 *
 * {@link verifyChain} and {@link exportAuditCsv} are registered as `command` so their successes are
 * recorded — verification is a deliberate button press, and an export is somebody taking a copy of the
 * record away with them. {@link auditArchiveCovering} is a `query` and stays quiet about working,
 * because it runs on every render of a filtered tab rather than when anybody presses anything; a row
 * per page load would bury the two above it.
 */

/** What verification found, in the shape the banner renders. */
export interface ChainStatus {
	/**
	 * True when the whole record verified, `"incomplete"` when everything the walk could reach did,
	 * false when the chain is broken, null when it has not been run this session.
	 *
	 * `ChainVerification`'s three states, carried through rather than collapsed: this drives a colour
	 * and an icon, and history that left before archiving existed is a retention setting rather than an
	 * incident — a red banner over it is the false alarm the third state was added to end.
	 *
	 * Spelled out rather than aliased to `ChainVerification["ok"]`, so a state added there is a type
	 * error here instead of a value the banner has no branch for and draws as "not verified".
	 */
	ok: boolean | "incomplete" | null;
	/** The operator-facing sentence, from `describeVerification`. */
	message: string;
}

/** The filter an export carries, as it crosses the wire — every field a string, or absent. */
export interface ExportRequest {
	actorUserId?: string;
	action?: string;
	outcome?: string;
	targetId?: string;
	from?: string;
	to?: string;
}

/** What an export hands back: the document, or the reason there is none. Never both. */
export interface ExportResult {
	csv: string | null;
	error: string | null;
}

/** The most rows one export carries. */
const EXPORT_LIMIT = 10_000;

/**
 * Walks the record and reports what it found.
 *
 * Run on demand rather than on every render of the tab, and more so now than when only the live rows
 * were walked: this recomputes a SHA-256 per row and decompresses every period the install has ever
 * archived. A page that shows fifty rows must not cost that on arrival, so it costs it when somebody
 * presses the button — which is also what gives `audit:verify` something to gate.
 *
 * **The archives and the epoch are both passed, and neither is optional.** Without the directory the
 * answer covers only what is still in the database, which on an install that archives is a fraction of
 * the record presented as the whole of it. Without the epoch a walk cannot tell history swept before
 * archiving existed — the state every install upgraded from the storage foundation is in — from an
 * archive somebody deleted, and reports the first as `link-mismatch`: an accusation of tampering
 * against a retention setting nobody touched. `verifyAuditChain` answers `"incomplete"` only when it
 * has both, so passing one without the other would leave that state unreachable from this page.
 *
 * `pnpm audit:verify` still exists and still asks the same question of the same files. It is the one an
 * operator reaches for when they have stopped trusting this page, which is the only thing this page
 * cannot do for them.
 *
 * @returns which of the three states the record is in, and the sentence to show
 */
export async function verifyChain(): Promise<ChainStatus> {
	// The type argument is given rather than inferred: without it `T` is fixed by the body's return,
	// where `ok` is the walk's own three states, and the `refused`/`failed` shapes carrying `ok: null`
	// no longer fit.
	return panelQuery<ChainStatus>(
		"audit:verify",
		async () => {
			const result = await verifyAuditChain(auditDb, {
				archiveDirectory: archiveDirectory(),
				epoch: await readEpoch(),
			});
			// Carried through rather than narrowed. `ChainVerification.ok` has an `"incomplete"` member and
			// it is a truthy string, so every collapse of it to a boolean — `result.ok !== false` included —
			// hands the banner the state that means "whole", which claims verification reached further back
			// than it did.
			return { ok: result.ok, message: describeVerification(result) };
		},
		{
			refused: () => ({ ok: null, message: "You do not have permission to verify the audit chain." }),
			failed: () => ({ ok: null, message: "Verification could not run. Check the server log." }),
		},
	);
}

/**
 * Renders a filtered range of the record as CSV.
 *
 * Bounded by {@link EXPORT_LIMIT} rather than unbounded, because the alternative is an action that
 * builds the entire table as one string in memory and hands it across the server-to-client boundary.
 * An operator who needs more than this is an operator who should be reading the database.
 *
 * @param request the filter, as the page holds it in the URL
 * @returns the CSV, or the message to show instead
 */
export async function exportAuditCsv(request: ExportRequest): Promise<ExportResult> {
	// Given rather than inferred, for the reason `verifyChain` gives: the body always succeeds with a
	// string and a null, and the two failure shapes are the other way round.
	return panelQuery<ExportResult>(
		"audit:export",
		async () => {
			const page = await listAuditEvents({ ...parseExportFilter(request), take: EXPORT_LIMIT });
			return { csv: toAuditCsv(page.events), error: null };
		},
		{
			refused: () => ({ csv: null, error: "You do not have permission to export the audit record." }),
			failed: (error) => ({
				csv: null,
				error: error instanceof ApiError ? error.message : "The export could not be built. Check the server log.",
			}),
			// The filter, and nothing else. A copy of the exported rows inside the record would double
			// the table every time somebody pressed the button.
			detail: { ...request },
		},
	);
}

/** What {@link listMoreAuditEvents} takes: the tab's current filter and sort, plus how many rows are already loaded. */
export interface AuditBatchRequest extends AuditSearchParams {
	offset: unknown;
}

/** What {@link listMoreAuditEvents} hands back. */
export interface AuditBatch {
	events: AuditEventSummary[];
	more: boolean;
	error: string | null;
}

/**
 * Loads the next batch of events for the Audit tab's infinite scroll.
 *
 * **Re-checks `audit:read` itself, rather than trusting that the page already did.** A server action
 * is a public endpoint reachable by anyone who can construct the POST it compiles to, not only by a
 * browser that first rendered the page behind `requirePagePermission` — the gate here is what actually
 * stops that request, not a formality restating one already run.
 *
 * **Registered `query`, unlike {@link verifyChain} and {@link exportAuditCsv} beside it.** Those two
 * are deliberate button presses and belong in the record; this runs on every approach to the bottom of
 * the table, and a row per scroll would bury the two actions on this tab actually worth recording.
 *
 * **Reuses `listAuditEvents`, the same function the page's own first batch comes from**, narrowed by
 * {@link parseAuditSearchParams} — the same parser the page uses on its own `searchParams` — so a batch
 * the sentinel appends is narrowed exactly as the page's own first batch was.
 *
 * @param request the tab's filter and sort, and how many events are already on screen
 * @returns the next batch, or an empty one with a reason when it could not be read
 */
export async function listMoreAuditEvents(request: AuditBatchRequest): Promise<AuditBatch> {
	return panelQuery<AuditBatch>(
		"audit:list-more",
		async () => {
			const filter = parseAuditSearchParams(request);
			const page = await listAuditEvents({
				actorUserId: filter.actorIds,
				action: filter.actions,
				outcome: filter.outcomes,
				targetId: filter.targetIds,
				from: filter.from,
				to: filter.to,
				sort: filter.sort,
				desc: filter.desc,
				skip: parseOffset(request.offset),
			});
			return { events: page.events, more: page.more, error: null };
		},
		{
			refused: () => ({ events: [], more: false, error: REFUSAL_MESSAGE }),
			failed: () => ({ events: [], more: false, error: "Something went wrong. Check the server log." }),
		},
	);
}

/**
 * The stretch of time a filtered view of the record is asking about.
 *
 * Both ends optional, because the tab's two date fields are set independently: "everything since
 * March" and "everything up to March" are both ranges an operator can ask for, and either can reach
 * back past the live window. A range with neither end is the whole record, which is the unfiltered tab,
 * and the page does not ask this about it: an archive offered under every default page load is scenery,
 * and stops being read long before it matters.
 *
 * Deliberately not `ExportRequest`'s strings. This one is called from the page itself rather than from
 * the browser, so the bounds have already been parsed by `dayBound` and re-spelling them as text would
 * mean parsing them a second time, in a second place, with a second idea of what a bad one means.
 */
export interface AuditRange {
	/** The earliest moment asked for. Absent means the range is open at that end. */
	from?: Date;
	/** The latest moment asked for. Absent means "up to now", which is what an open range ends at. */
	to?: Date;
}

/**
 * Finds the archived audit period a filtered range reaches into, if there is one.
 *
 * The Audit tab's signpost, and the sibling of `archiveCovering` in `lib/logs/log-service.ts`. That one
 * answers this question for the Logs tab and offers **log** archives only, correctly: its caller holds
 * `logs:read` and may hold nothing else. This one is the same question about the other record, so it
 * filters to `source === "audit"` and is gated by `audit:read`.
 *
 * **It has to exist, and it could not simply be that function called twice.** Before this branch an
 * aged-out audit row was deleted, so a filtered range that found nothing was telling the truth — the
 * rows really were gone. They are archived now, so the same empty table has become the exact failure
 * the split was supposed to remove rather than relocate: the data is somewhere the operator was not
 * told to look. On the record this system calls evidence, that is worse than it is on the log, and
 * archiving is not optional here the way `logs.archiveEnabled` makes it optional there.
 *
 * **Which archive covers a range.** An `audit` archive covers it when its period holds any moment the
 * range asks for: `periodKeyFor(from) <= periodKey <= periodKeyFor(to ?? now)`, with a range open at
 * the start matching every period up to its end. When several do, the **oldest** is returned, because
 * that is where the requested history begins and so the period to open first. An archive later than the
 * range's end is not offered: it holds nothing that was asked for, and a signpost pointing outside the
 * range is worse than none. `archiveCovering`'s own comment carries the longer argument for each of
 * these, including why a listed archive is already evidence that the range reaches back before the live
 * window and why a period whose *compression* failed is invisible to both of us.
 *
 * **UTC, from `periodKeyFor` and nowhere else.** Archive periods are named in UTC deliberately, and a
 * boundary that moved with the host's zone would put a range ending at 22:30 on the last of March into
 * April on this machine and not on the next one.
 *
 * **Never a reason the tab fails to render.** A refusal and a broken archive directory both answer
 * null, and the page renders no banner — the same silence as "nothing has been archived yet", which is
 * the honest answer when nobody can tell. The refusal and the failure are still written into the record
 * by the gate; only the success is not, because this runs on every filtered render.
 *
 * `/archives`, which the banner links to, opens for a caller holding **either** `logs:read` or
 * `audit:read` (`archives:list` is `custom` for exactly that reason), so the link works for a reader
 * who holds nothing but the permission that got them this answer.
 *
 * @param range what the filtered view is asking about; at least one end should be set, or the answer is
 *   about the whole record rather than about anything the operator narrowed to
 * @returns the period key of the oldest audit archive holding any of it, e.g. `2026-03`, or null when
 *   no archive does, when the caller may not read the record, or when the directory could not be read
 */
export async function auditArchiveCovering(range: AuditRange): Promise<string | null> {
	return panelQuery(
		"audit:archive-covering",
		async () => {
			// The empty string sorts before every `yyyy-mm`, so an open start matches every period rather
			// than none — which is what "everything up to March" asks for.
			const first = range.from === undefined ? "" : periodKeyFor(range.from);
			const last = periodKeyFor(range.to ?? new Date());

			let covering: string | null = null;

			for (const archive of await listArchives(archiveDirectory())) {
				if (archive.source !== "audit" || archive.periodKey < first || archive.periodKey > last) {
					continue;
				}
				// `periodKey` is `yyyy-mm` with the month zero-padded, so comparing two of them as text
				// orders them exactly as comparing them as dates would.
				if (covering === null || archive.periodKey < covering) {
					covering = archive.periodKey;
				}
			}

			return covering;
		},
		{
			refused: () => null,
			failed: () => null,
		},
	);
}

/**
 * Turns the wire shape into a filter, refusing anything it cannot read.
 *
 * A date that does not parse is refused rather than dropped. Dropping it would export the unfiltered
 * range under a heading that says otherwise, which on this table is a much worse answer than an
 * error.
 *
 * **The four dimensions arrive as the tab's own multi-value parameters** — the dropdowns are
 * multi-select, so `outcome` can be `DENIED,FAILURE`. Every one of them is parsed with the same
 * {@link parseValues} the page uses, which is the point of that function being shared: an export
 * that read the parameters differently from the table above it would quietly hand back a different
 * set of rows than the one on screen. Each outcome is still checked individually, so a value that
 * is not one this system uses refuses the export rather than narrowing it to nothing.
 *
 * @param request the filter as it crossed the wire
 * @returns the filter to query with
 * @throws ApiError when a bound is not a date, or an outcome is not one this system uses
 */
function parseExportFilter(request: ExportRequest): AuditFilter {
	const actorUserId = parseValues(request.actorUserId);
	const action = parseValues(request.action);
	const outcome = parseValues(request.outcome).map(parseOutcome);
	const targetId = parseValues(request.targetId);
	return {
		...(actorUserId.length > 0 ? { actorUserId } : {}),
		...(action.length > 0 ? { action } : {}),
		...(outcome.length > 0 ? { outcome } : {}),
		...(targetId.length > 0 ? { targetId } : {}),
		...(request.from ? { from: parseBound(request.from, "from") } : {}),
		...(request.to ? { to: parseBound(request.to, "to") } : {}),
	};
}

/**
 * @param value the bound as it crossed the wire
 * @param name which bound, for the message
 * @returns the parsed moment
 * @throws ApiError when it is not a date
 */
function parseBound(value: string, name: string): Date {
	const at = new Date(value);
	if (Number.isNaN(at.getTime())) {
		throw new ApiError("invalid_type", `The '${name}' date is not a date.`);
	}
	return at;
}

/**
 * @param value the outcome as it crossed the wire
 * @returns the outcome
 * @throws ApiError when it is not one this system uses
 */
function parseOutcome(value: string): AuditOutcome {
	if (!AuditOutcome.is(value)) {
		throw new ApiError("invalid_type", `'${value}' is not an audit outcome.`);
	}
	return value;
}
