"use client";

import { CheckCircle2, Download, ShieldAlert, ShieldQuestion } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { type ChainStatus, type ExportRequest, exportAuditCsv, verifyChain } from "@/app/(panel)/audit/actions";
import { Button } from "@/components/ui/button";

/**
 * Chain status, and the export button beside it.
 *
 * **Verification runs on request, not on render.** The walk recomputes a SHA-256 for every retained
 * row; paying that on each load of a page that shows fifty of them would make the tab's cost the
 * whole table's size. So the banner is always here, and it says the chain has not been verified in
 * this session until somebody asks — which is also what gives `audit:verify` something to gate.
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

	const tone =
		status.ok === true
			? "border-emerald-900 bg-emerald-950/40 text-emerald-300"
			: status.ok === false
				? "border-destructive/40 bg-destructive/10 text-destructive"
				: "border-border bg-muted/40 text-muted-foreground";

	const Icon = status.ok === true ? CheckCircle2 : status.ok === false ? ShieldAlert : ShieldQuestion;

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
