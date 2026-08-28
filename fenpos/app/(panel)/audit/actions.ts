"use server";

import { toAuditCsv } from "@/lib/audit/audit-csv";
import { type AuditFilter, listAuditEvents } from "@/lib/audit/audit-query";
import { readEpoch } from "@/lib/audit/epoch";
import { describeVerification, verifyAuditChain } from "@/lib/audit/verify";
import { panelQuery } from "@/lib/auth/panel-action";
import { auditDb } from "@/lib/db";
import { AuditOutcome } from "@/lib/domain/audit";
import { ApiError } from "@/lib/errors";
import { archiveDirectory } from "@/lib/maintenance/pass";

/**
 * Server actions behind the Audit tab.
 *
 * There is no create, no edit and no delete here, and there never will be: the record has one writer
 * (`lib/audit/audit-log.ts`) and one deleter (`lib/audit/retention.ts`), and neither is reachable
 * from the panel. Both of these are reads, registered as `command` so their successes are recorded —
 * verification is a deliberate button press, and an export is somebody taking a copy of the record
 * away with them.
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

/**
 * Turns the wire shape into a filter, refusing anything it cannot read.
 *
 * A date that does not parse is refused rather than dropped. Dropping it would export the unfiltered
 * range under a heading that says otherwise, which on this table is a much worse answer than an
 * error.
 *
 * @param request the filter as it crossed the wire
 * @returns the filter to query with
 * @throws ApiError when a bound is not a date, or the outcome is not one this system uses
 */
function parseExportFilter(request: ExportRequest): AuditFilter {
	return {
		...(request.actorUserId ? { actorUserId: request.actorUserId } : {}),
		...(request.action ? { action: request.action } : {}),
		...(request.outcome ? { outcome: parseOutcome(request.outcome) } : {}),
		...(request.targetId ? { targetId: request.targetId } : {}),
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
