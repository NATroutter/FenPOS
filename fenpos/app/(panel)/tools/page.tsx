import { Wrench } from "lucide-react";
import { TOOL_PERMISSIONS } from "@/app/(panel)/tab-permits";
import type { ToolDevice } from "@/app/(panel)/tools/device-picker";
import { MarkupTool } from "@/app/(panel)/tools/markup-tool";
import { RawTool } from "@/app/(panel)/tools/raw-tool";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { permitsFor } from "@/lib/auth/permits";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/db";
import { isConnected } from "@/lib/link/registry";
import { booleanSetting } from "@/lib/settings/settings-service";
import type { VariableKind } from "@/lib/variables/definition";

export const metadata = { title: "Tools" };

/**
 * What a variable's kind says about it, for a completion whose variable carries no description.
 *
 * Phrased as where the value comes from rather than as the enum's own word, because that is the
 * question an author picking between two names in a dropdown is actually asking.
 */
const KIND_NOTES: Record<VariableKind, string> = {
	STATIC: "a fixed value",
	DATETIME: "a date or time",
	CONTEXT: "read from the print",
};

/** Never cached: which agents are reachable changes without a request causing it. */
export const dynamic = "force-dynamic";

/**
 * The Tools tab.
 *
 * Two things an operator needs when a printer is not behaving: compose markup and see exactly
 * what it will produce, or drive the printer in its own language when the markup layer is not the
 * problem. They are separate cards because they answer different questions, and putting them
 * behind one editor would invite sending a receipt as raw bytes.
 */
export default async function ToolsPage() {
	// Outside any try: both an absent session and a refusal signal by throwing.
	const user = await requirePagePermission("tools:read", "/tools");

	const [rows, fonts, variables, variablesEnabled, permits] = await Promise.all([
		prisma.device.findMany({
			orderBy: [{ agent: { name: "asc" } }, { name: "asc" }],
			select: {
				id: true,
				name: true,
				agentId: true,
				columns: true,
				codepage: true,
				agent: { select: { name: true } },
			},
		}),
		// What a `<text font=…>` may name beyond the printer's own two faces. Names only: the editor
		// offers them as completions and the compile resolves them again from the database, so nothing
		// here is trusted for anything. `tools:read` already names the images and variables that exist,
		// through the markup documentation, so a font's name is no more than the tab already tells.
		prisma.asset.findMany({ where: { kind: "FONT" }, orderBy: { name: "asc" }, select: { name: true } }),
		// What a `{name}` may refer to. The rows rather than `listMarkupVariables`, which is what the
		// Insert dialog's picker calls: that action evaluates every variable to show what it resolves
		// to right now, and a completion shows a name and a note beside it. Paying for an evaluation
		// per variable on every load of this tab — and an audit entry for the read — to fill a dropdown
		// the author may never open is the wrong trade.
		prisma.variable.findMany({
			orderBy: { name: "asc" },
			select: { name: true, kind: true, description: true },
		}),
		// A brace is ordinary text while this is off, so offering a name would promise a substitution
		// that will not happen.
		booleanSetting("variables.enabled"),
		// Resolved here because a client component cannot read the database. Convenience only — every
		// action is refused again by its own gate; see `permitsFor`.
		permitsFor(user, TOOL_PERMISSIONS),
	]);

	// The markup card is an editor whose output goes to one of two places. With neither, it composes
	// text nothing can be done with, so it is not shown at all.
	const showMarkup = permits["tools:preview"] || permits["tools:print"];

	const devices: ToolDevice[] = rows.map((row) => ({
		id: row.id,
		agentName: row.agent.name,
		deviceName: row.name,
		columns: row.columns,
		codepage: row.codepage,
		online: isConnected(row.agentId),
	}));

	return (
		<div className="flex flex-col gap-5">
			{showMarkup ? (
				<MarkupTool
					devices={devices}
					fonts={fonts.map((font) => font.name)}
					variables={
						variablesEnabled
							? variables.map((variable) => ({
									name: variable.name,
									// The description when the operator wrote one, since it says what the variable is
									// for; the kind otherwise, which at least says where its value comes from.
									// The column is free text to Prisma; `variableDefinitionSchema` is what holds a
									// written row to the three kinds, so anything else here is a row this build did
									// not write and is left to speak for itself.
									detail: variable.description ?? KIND_NOTES[variable.kind as VariableKind] ?? null,
								}))
							: []
					}
					canPreview={permits["tools:preview"]}
					canPrint={permits["tools:print"]}
				/>
			) : null}
			{permits["tools:raw"] ? <RawTool devices={devices} /> : null}

			{/* `tools:read` on its own is a real grant — it is what lets the markup documentation name
			    the images and variables that exist — so this page can legitimately have nothing to
			    show. Saying so beats a blank page that looks like a failure. */}
			{!showMarkup && !permits["tools:raw"] ? (
				<Empty className="border border-dashed border-border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Wrench />
						</EmptyMedia>
						<EmptyTitle>Nothing to compose with</EmptyTitle>
						<EmptyDescription>
							Composing markup needs the preview or print permission, and raw bytes need their own. Ask an administrator
							for whichever you need.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : null}
		</div>
	);
}
