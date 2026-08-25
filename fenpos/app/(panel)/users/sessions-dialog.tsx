"use client";

import { type ReactElement, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { listSessions, revokeUserSession, revokeUserSessions, type UserSession } from "@/app/(panel)/users/actions";
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
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime } from "@/lib/format/datetime";

/**
 * An account's live sessions, individually revocable.
 *
 * Sessions here are database rows rather than self-contained tokens, which is the whole reason this
 * dialog can exist: revoking one ends it now, not when it would have expired.
 *
 * The list is fetched when the dialog opens rather than passed down with the row, because a session
 * list goes stale the moment somebody signs in on their phone, and a stale list with a Revoke button
 * beside each line is worse than a brief spinner.
 */
export function SessionsDialog({
	userId,
	accountName,
	trigger,
}: {
	userId: string;
	accountName: string;
	trigger: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	const [sessions, setSessions] = useState<UserSession[] | null>(null);
	const [pending, startTransition] = useTransition();

	useEffect(() => {
		if (!open) {
			setSessions(null);
			return;
		}
		let current = true;
		void listSessions(userId).then((found) => {
			if (current) {
				setSessions(found);
			}
		});
		return () => {
			current = false;
		};
	}, [open, userId]);

	const revokeOne = (sessionId: string): void => {
		startTransition(async () => {
			const result = await revokeUserSession(userId, sessionId);
			if (result.error) {
				toast.error(result.error);
				return;
			}
			setSessions((current) => (current ?? []).filter((session) => session.id !== sessionId));
		});
	};

	const revokeAll = (): void => {
		startTransition(async () => {
			const result = await revokeUserSessions(userId);
			if (result.error) {
				toast.error(result.error);
				return;
			}
			setSessions([]);
			toast.success(`${accountName} signed out everywhere.`);
		});
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-[560px]">
				<DialogHeader>
					<DialogTitle>{accountName}&apos;s sessions</DialogTitle>
					<DialogDescription>Revoking one ends it immediately, wherever it is open.</DialogDescription>
				</DialogHeader>
				<DialogBody>
					{sessions === null ? (
						<Spinner className="size-4" />
					) : sessions.length === 0 ? (
						<p className="text-[12px] text-subtle-foreground">No sessions open.</p>
					) : (
						<div className="flex flex-col gap-2">
							{sessions.map((session) => (
								<div key={session.id} className="flex items-center gap-3 border-b border-border pb-2 last:border-b-0">
									<div className="min-w-0 flex-1">
										<div className="truncate font-mono text-[12px]">{session.ipAddress ?? "address unknown"}</div>
										<div className="truncate text-[11.5px] text-subtle-foreground">
											{session.userAgent ?? "agent unknown"} · last seen {formatDateTime(session.updatedAt)}
										</div>
									</div>
									<Button variant="outline" size="sm" disabled={pending} onClick={() => revokeOne(session.id)}>
										Revoke
									</Button>
								</div>
							))}
						</div>
					)}
				</DialogBody>
				<DialogFooter>
					<Button type="button" variant="outline" onClick={() => setOpen(false)}>
						Close
					</Button>
					<Button
						type="button"
						variant="destructive"
						disabled={pending || sessions === null || sessions.length === 0}
						onClick={revokeAll}
					>
						Revoke all
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
