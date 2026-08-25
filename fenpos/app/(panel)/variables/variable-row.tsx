"use client";

import { Lock, Pencil, Trash2 } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { removeVariable } from "@/app/(panel)/variables/actions";
import { VariableDialog } from "@/app/(panel)/variables/variable-dialog";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TableCell, TableRow } from "@/components/ui/table";
import type { ContextSource, VariableDefinition, VariableKind } from "@/lib/variables/definition";

/** Plain-language labels for {@link VariableKind}, in the order the panel presents them. */
export const KIND_LABELS: Record<VariableKind, string> = {
	STATIC: "Static text",
	DATETIME: "Date & time",
	CONTEXT: "From the print",
};

/**
 * Plain-language labels for {@link ContextSource}.
 *
 * Shared between the dialog's picker and this row's display, so a `CONTEXT` variable's source
 * reads the same word whichever of the two an operator is looking at.
 */
export const CONTEXT_LABELS: Record<ContextSource, string> = {
	DEVICE_NAME: "Printer name",
	AGENT_NAME: "Agent name",
	API_KEY_NAME: "API key name",
};

/** A variable as this row and the dialog it opens both need it, serialised for the client boundary. */
export interface VariableRowData extends VariableDefinition {
	id: string;
	/** What this variable prints right now, or null when variables are off or it could not be evaluated. */
	resolvesTo: string | null;
}

/**
 * One defined variable: what it is, what it currently produces, and how to change or remove it.
 *
 * The lock icon rather than a second text column for `overridable`: it is a yes/no fact about one
 * flag, and a glance at a padlock says it faster than a word would, the same way the Keys tab uses a
 * badge rather than a sentence for "revoked".
 */
export function VariableRow({ variable }: { variable: VariableRowData }) {
	const [pending, startTransition] = useTransition();

	return (
		<TableRow>
			<TableCell className="font-mono text-[12.5px]">{`{${variable.name}}`}</TableCell>
			<TableCell className="text-[12.5px]">{KIND_LABELS[variable.kind]}</TableCell>
			{/* Titled for the same reason the description cell below is: the column is truncated, and a
			    static value or a formatted date is exactly the kind of thing an operator needs to read
			    in full to tell whether it is right. */}
			<TableCell
				className="max-w-[220px] truncate font-mono text-[12px] text-subtle-foreground"
				title={variable.resolvesTo ?? undefined}
			>
				{variable.resolvesTo ?? "—"}
			</TableCell>
			<TableCell>
				{variable.overridable ? null : (
					<Lock className="size-3.5 text-subtle-foreground" aria-label="Not overridable from a print request" />
				)}
			</TableCell>
			<TableCell
				className="max-w-[260px] truncate text-[12px] text-subtle-foreground"
				title={variable.description ?? undefined}
			>
				{variable.description ?? "—"}
			</TableCell>
			<TableCell>
				<div className="flex items-center justify-end gap-1.5">
					<VariableDialog
						variableId={variable.id}
						initial={variable}
						trigger={
							<Button
								variant="outline"
								size="icon"
								className="size-8"
								title="Edit"
								aria-label={`Edit ${variable.name}`}
							>
								<Pencil className="size-3.5" />
							</Button>
						}
					/>

					<AlertDialog>
						<AlertDialogTrigger
							disabled={pending}
							render={
								<Button
									variant="outline"
									size="icon"
									className="size-8 border-destructive/40 text-destructive hover:bg-destructive/10"
									title="Delete"
									aria-label={`Delete ${variable.name}`}
								>
									{pending ? <Spinner className="size-3.5" /> : <Trash2 className="size-3.5" />}
								</Button>
							}
						/>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Delete {variable.name}?</AlertDialogTitle>
								<AlertDialogDescription>
									Any receipt that says <span className="font-mono">{`{${variable.name}}`}</span> fails to compile until
									it is changed, or until a variable of that name is defined again. This cannot be undone.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction
									className="bg-destructive text-white hover:bg-destructive/90"
									onClick={() =>
										startTransition(async () => {
											const result = await removeVariable(variable.id);
											if (result.error) {
												toast.error(result.error);
											} else {
												toast.success(`${variable.name} deleted.`);
											}
										})
									}
								>
									Delete
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</div>
			</TableCell>
		</TableRow>
	);
}
