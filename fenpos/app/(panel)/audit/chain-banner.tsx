"use client";

import { CheckCircle2, Download, type LucideIcon, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { type ChainStatus, type ExportRequest, exportAuditCsv, verifyChain } from "@/app/(panel)/audit/actions";
import { Button } from "@/components/ui/button";

/**
 * Chain status, and the export button beside it.
 *
 * **Verification runs on request, not on render.** The walk recomputes a SHA-256 for every row in the
 * record, decompressing each archived period to reach the ones no longer in the database; paying that
 * on each load of a page that shows fifty rows would make the tab's cost the whole record's size. So
 * the banner is always here, and it says the chain has not been verified in this session until
 * somebody asks — which is also what gives `audit:verify` something to gate.
 *
 * Both controls are rendered only when the account holds the permission behind them. The actions
 * check again regardless; that is the boundary, and this is the courtesy.
 */
export function ChainBanner({
	canVerify,
	canExport,
	filter,
}: {
	canVerify: boolean;
	canExport: boolean;
	filter: ExportRequest;
}) {
	const [status, setStatus] = useState<ChainStatus>({
		ok: null,
		message: "The chain has not been verified in this session.",
	});
	const [verifying, startVerify] = useTransition();
	const [exporting, startExport] = useTransition();

	const { tone, Icon } = presentation(status.ok);

	return (
		<div className={`flex flex-wrap items-center gap-3 rounded-md border p-3 ${tone}`}>
			<Icon className="size-4 shrink-0" />
			<p className="min-w-0 flex-1 whitespace-pre-line text-[12px]">{status.message}</p>

			{canVerify ? (
				<Button
					variant="outline"
					size="sm"
					disabled={verifying}
					onClick={() => startVerify(async () => setStatus(await verifyChain()))}
				>
					{verifying ? "Verifying…" : "Verify chain"}
				</Button>
			) : null}

			{canExport ? (
				<Button
					variant="outline"
					size="sm"
					disabled={exporting}
					onClick={() =>
						startExport(async () => {
							const result = await exportAuditCsv(filter);
							if (result.csv === null) {
								toast.error(result.error ?? "The export could not be built.");
								return;
							}
							download(result.csv);
						})
					}
				>
					<Download className="size-3" />
					{exporting ? "Exporting…" : "Export CSV"}
				</Button>
			) : null}
		</div>
	);
}

/**
 * The colour and the icon for each of the four things this banner can be saying.
 *
 * **An incomplete chain is drawn as a note rather than as a warning, and that is the point of it.** A
 * chain that verifies from the epoch onwards is a correctly configured install whose oldest history
 * left before archiving existed to catch it — the state every install upgraded from the storage
 * foundation is in.
 *
 * **Sky is borrowed here, not inherited.** The convention this panel states is `doc-section.tsx`'s:
 * emerald "it worked", sky "in flight", destructive "it failed", and the Jobs tab uses sky for
 * `PRINTING`. It has no hue for "verified as far as the record goes", because nothing before this had
 * to say it. Sky is taken because of the three named, it is the only one that is not a verdict on
 * whether something worked — and the two that are wrong here are wrong in opposite directions:
 * emerald would claim the whole record verified, destructive would say it was altered. Amber, this
 * panel's "attend to this", would say an operator has a problem they do not have. Muted is spoken for
 * by the branch below, where nobody has asked yet.
 *
 * What actually distinguishes this from a whole chain is `describeVerification`'s sentence, which
 * names the `seq` verification reaches back to; the colour's job is only to not contradict it.
 *
 * Compared by value at every branch and never for truthiness: `"incomplete"` is a truthy string, so
 * `ok ? … : …` would draw it exactly as a whole chain and no compiler would say so.
 *
 * Exported for `test/app/(panel)/audit/chain-banner.test.ts`, which is what pins the distinction the
 * paragraphs above argue for — that this state draws as neither the whole chain, the failure, nor the
 * banner nobody has asked anything of yet. It is a pure function of `ok` precisely so that can be
 * checked without a DOM: reordering or collapsing these four branches is otherwise silent.
 *
 * @param ok what the walk found, or null before anybody has asked in this session
 * @returns the border, background and text classes, and the icon that goes beside them
 */
export function presentation(ok: ChainStatus["ok"]): { tone: string; Icon: LucideIcon } {
	if (ok === true) {
		return { tone: "border-emerald-900 bg-emerald-950/40 text-emerald-300", Icon: CheckCircle2 };
	}
	if (ok === "incomplete") {
		return { tone: "border-sky-900 bg-sky-950/40 text-sky-300", Icon: ShieldCheck };
	}
	if (ok === false) {
		return { tone: "border-destructive/40 bg-destructive/10 text-destructive", Icon: ShieldAlert };
	}
	return { tone: "border-border bg-muted/40 text-muted-foreground", Icon: ShieldQuestion };
}

/**
 * Hands the CSV to the browser as a file.
 *
 * A blob URL behind a synthetic click. The alternative — a route that re-runs the query and streams
 * it — would be a second, differently-gated way to read the whole record, which is one more than this
 * needs.
 *
 * **Two details are deliberate, and neither is decoration.** The anchor is put into the document
 * before it is clicked, because a click on a detached anchor is not reliably honoured across
 * browsers. And the object URL is revoked on a later tick rather than on the next line, because
 * revoking synchronously can pull the blob out from under a download that has been started but not
 * yet read. Both failures are silent when they happen — no error, no file — which is why this is
 * written the careful way rather than the short way.
 *
 * @param csv the document to save
 */
function download(csv: string): void {
	const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
	anchor.style.display = "none";

	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();

	setTimeout(() => URL.revokeObjectURL(url), 0);
}
