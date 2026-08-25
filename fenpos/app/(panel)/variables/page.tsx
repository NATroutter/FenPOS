import { Braces, Plus } from "lucide-react";
import Link from "next/link";
import { VariableDialog } from "@/app/(panel)/variables/variable-dialog";
import { VariableRow, type VariableRowData } from "@/app/(panel)/variables/variable-row";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { logger } from "@/lib/logger";
import { resolveVariables } from "@/lib/markup/resolve-variables";
import { booleanSetting } from "@/lib/settings/settings-service";
import { PANEL_PRINT_CONTEXT } from "@/lib/variables/formatting";
import { listVariables } from "@/lib/variables/variable-service";

export const metadata = { title: "Variables" };

/** Never cached: a `DATETIME` variable's "resolves to" column is a live clock reading. */
export const dynamic = "force-dynamic";

/**
 * The Variables tab.
 *
 * The "resolves to" column is built from `resolveVariables`, the exact function a real print
 * compiles against, against a synthetic, install-wide context — an empty `deviceId` deliberately
 * returns no device overrides, so the figure shown is the one every printer sees before any
 * printer-specific override is applied. It is a snapshot, not a promise: a `DATETIME` variable's
 * column will read differently a minute from now, and that is the point of showing it rather than
 * the raw pattern.
 */
export default async function VariablesPage() {
	// Outside any try: both an absent session and a refusal signal by throwing.
	await requirePagePermission("variables:read");

	const [variables, enabled] = await Promise.all([listVariables(), booleanSetting("variables.enabled")]);

	// `resolveVariables` returns null when the feature is off, which is handled below with the
	// banner. A row it cannot evaluate is now omitted from the map rather than thrown through — so
	// that row alone reads "—" and every other variable still shows its value, which is the outcome
	// this catch was written to approximate and could not: it could only tell that *something* had
	// failed, and blanked the whole column for it. The catch stays for anything that genuinely does
	// escape — a settings read, a database fault — where a table with no values beats no page.
	let resolved: ReadonlyMap<string, string> | null = null;
	if (enabled) {
		try {
			const context = await resolveVariables({ deviceId: "", context: PANEL_PRINT_CONTEXT, supplied: {} });
			resolved = context?.values ?? null;
		} catch (error) {
			logger.error("Could not resolve variables for the panel table", error);
		}
	}

	const rows: VariableRowData[] = variables.map((variable) => ({
		id: variable.id,
		name: variable.name,
		kind: variable.kind,
		value: variable.value,
		pattern: variable.pattern,
		offsetAmount: variable.offsetAmount,
		offsetUnit: variable.offsetUnit,
		source: variable.source,
		overridable: variable.overridable,
		description: variable.description,
		resolvesTo: resolved?.get(variable.name) ?? null,
	}));

	return (
		<div className="flex flex-col gap-5">
			{enabled ? null : (
				<Alert>
					<AlertDescription>
						Variables are switched off, so <span className="font-mono">{"{name}"}</span> prints as plain text rather
						than being substituted. Turn on <span className="font-mono">Enable variables</span> on the{" "}
						<Link href="/settings">Settings</Link> tab to have these fill in when a receipt prints.
					</AlertDescription>
				</Alert>
			)}

			{/* The section's own description is in the top bar; what is left here is the one action
			    this page offers, kept on its own row so it stays put as the table below changes. */}
			<div className="flex justify-end">
				<VariableDialog
					trigger={
						<Button>
							<Plus className="size-3.5" />
							Add variable
						</Button>
					}
				/>
			</div>

			{rows.length === 0 ? (
				<Empty className="border border-dashed border-border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Braces />
						</EmptyMedia>
						<EmptyTitle>No variables yet</EmptyTitle>
						<EmptyDescription>
							A variable is a value receipts refer to by name. Define <span className="font-mono">phone</span> here and
							write <span className="font-mono">{"{phone}"}</span> in a receipt, and the number is filled in when it
							prints — so changing it later is one edit, not one per layout.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Name</TableHead>
							<TableHead>Kind</TableHead>
							<TableHead>Resolves to</TableHead>
							<TableHead className="w-[36px]" />
							<TableHead>Description</TableHead>
							<TableHead className="w-[96px]" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((variable) => (
							<VariableRow key={variable.id} variable={variable} />
						))}
					</TableBody>
				</Table>
			)}
		</div>
	);
}
