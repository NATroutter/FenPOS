"use client";

import { Plus } from "lucide-react";
import { useActionState, useEffect, useState } from "react";
import { type ActionState, IDLE } from "@/app/(panel)/agents/action-state";
import { createAgent } from "@/app/(panel)/agents/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toNameCandidate } from "@/lib/domain/naming";

/**
 * Creates a agent and issues its first pairing code.
 *
 * The name is a slug because it becomes a path segment in the public print API. Rather than
 * rejecting "Kitchen Printer" outright, the field normalises what is typed as it is typed, so
 * the operator sees the name they are actually creating before they commit to it.
 */
export function AddAgentDialog() {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [state, formAction, pending] = useActionState<ActionState, FormData>(createAgent, IDLE);

	// Closing on success has to wait for the action to settle, so it is driven by the
	// resulting state rather than by the submit handler.
	useEffect(() => {
		if (!pending && state.error === null && open && name !== "") {
			setOpen(false);
			setName("");
		}
		// `state` is the completion signal; reacting to `name` or `open` here would close the
		// dialog the moment it opened.
	}, [state, pending]);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setName("");
				}
			}}
		>
			<DialogTrigger
				render={
					<Button>
						<Plus className="size-3.5" />
						Add agent
					</Button>
				}
			/>
			<DialogContent className="sm:max-w-[420px]">
				<form action={formAction}>
					<DialogHeader>
						<DialogTitle>Add a agent</DialogTitle>
						<DialogDescription>
							A agent is one machine with printers attached. Naming it now issues a pairing code you enter on that
							machine.
						</DialogDescription>
					</DialogHeader>

					<div className="py-4">
						<Field>
							<FieldLabel htmlFor="agent-name">Name</FieldLabel>
							<Input
								id="agent-name"
								name="name"
								value={name}
								onChange={(event) => setName(toNameCandidate(event.target.value, { keepTrailingSeparator: true }))}
								placeholder="kitchen"
								className="font-mono"
								autoComplete="off"
								required
							/>
							<FieldDescription>
								Becomes part of the print API path, as in{" "}
								<code className="font-mono">/api/print/{name || "kitchen"}/…</code>
							</FieldDescription>
						</Field>

						{state.error ? (
							<Alert variant="destructive" className="mt-3">
								<AlertDescription>{state.error}</AlertDescription>
							</Alert>
						) : null}
					</div>

					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={pending || name.length === 0}>
							{pending ? <Spinner /> : null}
							Create agent
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
