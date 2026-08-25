"use client";

import { type ReactElement, useState, useTransition } from "react";
import { toast } from "sonner";
import { banUser } from "@/app/(panel)/users/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
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

/**
 * Bans an account, with a reason and an optional expiry.
 *
 * A reason is required rather than optional, and the service refuses an empty one: a ban is read
 * months later by somebody deciding whether to lift it, and a row that says only "banned" cannot be
 * acted on.
 *
 * The expiry is a plain date input, sent as an ISO string. An empty one means a ban that does not
 * lift on its own.
 */
export function BanDialog({
	userId,
	accountName,
	trigger,
}: {
	userId: string;
	accountName: string;
	trigger: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	const [reason, setReason] = useState("");
	const [until, setUntil] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, startSave] = useTransition();

	const save = (): void => {
		setError(null);
		startSave(async () => {
			// A date input gives a bare `YYYY-MM-DD`, which parses as midnight UTC. The ban lifts at
			// the start of that day rather than the end of the previous one, which is what an operator
			// picking a date means.
			const expiresAt = until === "" ? null : new Date(`${until}T00:00:00Z`).toISOString();
			const result = await banUser(userId, reason, expiresAt);
			if (result.error) {
				setError(result.error);
				return;
			}
			toast.success(`${accountName} banned. Their sessions have ended.`);
			setOpen(false);
		});
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				setReason("");
				setUntil("");
				setError(null);
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-[440px]">
				<DialogHeader>
					<DialogTitle>Ban {accountName}</DialogTitle>
					<DialogDescription>
						Their sessions end now and they cannot sign in again. The account, its grants and its history are kept.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="flex flex-col gap-4">
						<Field>
							<FieldLabel htmlFor="ban-reason">Reason</FieldLabel>
							<Input
								id="ban-reason"
								value={reason}
								disabled={saving}
								placeholder="Left the company"
								onChange={(event) => setReason(event.target.value)}
							/>
							<FieldDescription>Read by whoever decides later whether to lift it.</FieldDescription>
						</Field>

						<Field>
							<FieldLabel htmlFor="ban-until">Lifts on</FieldLabel>
							<Input
								id="ban-until"
								type="date"
								value={until}
								disabled={saving}
								onChange={(event) => setUntil(event.target.value)}
							/>
							<FieldDescription>Leave empty for a ban that stays until it is lifted by hand.</FieldDescription>
						</Field>

						{error ? (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
					</div>
				</DialogBody>
				<DialogFooter>
					<Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button type="button" disabled={saving || reason.trim() === ""} onClick={save}>
						{saving ? <Spinner className="size-3.5" /> : null}
						Ban account
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
