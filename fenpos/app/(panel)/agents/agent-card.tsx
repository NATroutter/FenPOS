"use client";

import { FileText, Printer, Server, Trash2, Unplug } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { deleteAgent, renameAgent, sendTestPrint, unpairAgent } from "@/app/(panel)/agents/actions";
import { PairingPanel } from "@/app/(panel)/agents/pairing-panel";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardActions, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { AgentStatus } from "@/lib/domain/enums";
import { formatDateTime } from "@/lib/format/datetime";

/** A agent as this component needs it, serialised for the client boundary. */
export interface AgentCardData {
	id: string;
	name: string;
	status: AgentStatus;
	lastSeenAt: string | null;
	agentVersion: string | null;
	platform: string | null;
	hostname: string | null;
	lastAddress: string | null;
	deviceCount: number;
	pairing: { code: string; expiresAt: string } | null;
}

/** Chip styling per connection state. */
const STATUS_STYLE: Record<AgentStatus, { label: string; className: string }> = {
	ONLINE: { label: "Online", className: "border-emerald-900 bg-emerald-950 text-emerald-400" },
	OFFLINE: { label: "Offline", className: "border-border bg-muted text-muted-foreground" },
	PENDING: { label: "Awaiting pairing", className: "border-amber-900 bg-amber-950 text-amber-400" },
};

/**
 * One agent: what it is, whether it is reachable, and what can be done to it.
 *
 * An unpaired agent shows the pairing panel in place of its details, because until it pairs
 * there are no details to show and the code is the only thing an operator needs.
 */
export function AgentCard({
	agent,
	serverAddress,
	addressIsInferred,
	pairingEnabled,
}: {
	agent: AgentCardData;
	serverAddress: string;
	addressIsInferred: boolean;
	/** Whether `/api/pair` currently accepts codes at all. Passed through to {@link PairingPanel}. */
	pairingEnabled: boolean;
}) {
	const [pending, startTransition] = useTransition();
	const status = STATUS_STYLE[agent.status];

	return (
		<Card className="flex flex-col">
			<CardHeader className="flex flex-row items-center gap-3 border-b border-border pb-3">
				<Server className="size-4.5 shrink-0 text-subtle-foreground" />
				<AgentName agentId={agent.id} name={agent.name} />
				<Badge variant="outline" className={`shrink-0 ${status.className}`}>
					{status.label}
				</Badge>
			</CardHeader>

			<CardContent className="flex flex-1 flex-col gap-4 pt-4">
				{agent.pairing ? (
					<PairingPanel
						agentId={agent.id}
						agentName={agent.name}
						code={agent.pairing.code}
						expiresAt={agent.pairing.expiresAt}
						serverAddress={serverAddress}
						addressIsInferred={addressIsInferred}
						pairingEnabled={pairingEnabled}
					/>
				) : (
					<Details agent={agent} />
				)}
				<CardActions className="flex-nowrap gap-2">
					<span className="flex items-center gap-1.5 text-[11.5px] text-subtle-foreground">
						<Printer className="size-3.5" />
						{agent.deviceCount} {agent.deviceCount === 1 ? "printer" : "printers"}
					</span>

					<div className="flex-1" />

					{agent.status === "ONLINE" && agent.deviceCount > 0 ? (
						<Button
							variant="outline"
							size="icon"
							className="size-8"
							title="Send a test job through the server"
							aria-label="Send a test job through the server"
							disabled={pending}
							onClick={() =>
								startTransition(async () => {
									const result = await sendTestPrint(agent.id);
									if (result.error) {
										toast.error(result.error);
									} else {
										toast.success(`Test page sent to .`);
									}
								})
							}
						>
							{pending ? <Spinner className="size-3.5" /> : <FileText className="size-3.5" />}
						</Button>
					) : null}

					{agent.status === "PENDING" ? null : (
						<Confirm
							title={`Unpair ?`}
							description="The agent loses its credential and is disconnected immediately. Its printers are kept, so pairing a replacement machine restores the site without reconfiguring them."
							confirmLabel="Unpair"
							disabled={pending}
							onConfirm={() =>
								startTransition(async () => {
									const result = await unpairAgent(agent.id);
									if (result.error) {
										toast.error(result.error);
									} else {
										toast.success(`${agent.name} unpaired.`);
									}
								})
							}
							trigger={
								<Button variant="outline" size="icon" className="size-8" title="Unpair" aria-label="Unpair agent">
									<Unplug className="size-3.5" />
								</Button>
							}
						/>
					)}

					<Confirm
						title={`Delete ${agent.name}?`}
						description={
							agent.deviceCount > 0
								? `This also deletes ${agent.deviceCount} configured ${
										agent.deviceCount === 1 ? "printer" : "printers"
									} and their job history. This cannot be undone.`
								: "This cannot be undone."
						}
						confirmLabel="Delete"
						destructive
						disabled={pending}
						onConfirm={() =>
							startTransition(async () => {
								const result = await deleteAgent(agent.id);
								if (result.error) {
									toast.error(result.error);
								} else {
									toast.success(`${agent.name} deleted.`);
								}
							})
						}
						trigger={
							<Button
								variant="outline"
								size="icon"
								className="size-8 border-destructive/40 text-destructive hover:bg-destructive/10"
								title="Delete"
								aria-label="Delete agent"
							>
								<Trash2 className="size-3.5" />
							</Button>
						}
					/>
				</CardActions>
			</CardContent>
		</Card>
	);
}

/** Details of a paired agent. Absent values read as an em dash rather than an empty gap. */
function Details({ agent }: { agent: AgentCardData }) {
	return (
		<dl className="grid grid-cols-2 gap-x-4 gap-y-3">
			<Detail label="Host" value={agent.hostname} />
			<Detail label="Platform" value={agent.platform} />
			<Detail label="Agent" value={agent.agentVersion} />
			<Detail label="Address" value={agent.lastAddress} />
			<Detail label="Last seen" value={agent.lastSeenAt ? formatDateTime(agent.lastSeenAt) : null} />
		</dl>
	);
}

function Detail({ label, value }: { label: string; value: string | null }) {
	return (
		<div className="min-w-0">
			<dt className="text-[11px] font-medium text-subtle-foreground">{label}</dt>
			<dd className="mt-0.5 truncate font-mono text-[12.5px]">{value ?? "—"}</dd>
		</div>
	);
}

/**
 * The agent name, editable in place.
 *
 * Committed on blur or Enter and reverted on Escape. The name is part of the public API path,
 * so a rename changes the URL clients use — the confirmation for that is the toast, not a
 * dialog, because the change is trivially reversible by renaming back.
 */
function AgentName({ agentId, name }: { agentId: string; name: string }) {
	const [value, setValue] = useState(name);
	const [pending, startTransition] = useTransition();

	const commit = (): void => {
		const trimmed = value.trim();
		if (trimmed === name) {
			return;
		}
		startTransition(async () => {
			const result = await renameAgent(agentId, trimmed);
			if (result.error) {
				toast.error(result.error);
				setValue(name);
			} else {
				toast.success(`Renamed to ${trimmed}.`);
			}
		});
	};

	return (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			<Input
				value={value}
				disabled={pending}
				onChange={(event) => setValue(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.currentTarget.blur();
					}
					if (event.key === "Escape") {
						setValue(name);
						event.currentTarget.blur();
					}
				}}
				aria-label="Agent name"
				className="h-8 border-transparent bg-transparent font-mono text-sm font-semibold hover:border-border focus:border-border"
			/>
			{pending ? <Spinner className="size-3.5 shrink-0" /> : null}
		</div>
	);
}

/** A destructive action behind a confirmation dialog. */
function Confirm({
	title,
	description,
	confirmLabel,
	trigger,
	onConfirm,
	disabled,
	destructive = false,
}: {
	title: string;
	description: string;
	confirmLabel: string;
	/** Must be a single element: Base UI clones it to attach the trigger behaviour. */
	trigger: React.ReactElement;
	onConfirm: () => void;
	disabled?: boolean;
	destructive?: boolean;
}) {
	return (
		<AlertDialog>
			<AlertDialogTrigger disabled={disabled} render={trigger} />
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={onConfirm}
						className={destructive ? "bg-destructive text-white hover:bg-destructive/90" : undefined}
					>
						{confirmLabel}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
