"use client";

import { FileText, Pause, Play, Plug, PlugZap, Printer, Settings2, Trash, Trash2 } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { clearQueue, deleteDevice, printTestPage, setConnected, setPaused } from "@/app/(panel)/devices/actions";
import { DeviceDialog, type DeviceFormValues, type OverridableVariable } from "@/app/(panel)/devices/device-dialog";
import type { DevicePermits } from "@/app/(panel)/tab-permits";
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
import { Spinner } from "@/components/ui/spinner";
import type { ConnectionStatus } from "@/lib/domain/enums";

/** A printer as this component needs it, serialised for the client boundary. */
export interface DeviceCardData {
	id: string;
	agentId: string;
	agentName: string;
	agentOnline: boolean;
	name: string;
	paused: boolean;
	connection: ConnectionStatus | null;
	queueDepth: number | null;
	settings: DeviceFormValues;
	/** This printer's `STATIC` variables and its own value for each, for the Configure dialog's overrides section. */
	variables: OverridableVariable[];
}

/**
 * Chip styling per observed connection state.
 *
 * `null` is its own state and reads as "Unknown", not as disconnected. While an agent is
 * connecting it has genuinely not said yet, and claiming a printer is unreachable when nobody
 * has asked is a confident wrong answer.
 */
const CONNECTION_STYLE: Record<ConnectionStatus, { label: string; className: string }> = {
	CONNECTED: { label: "Connected", className: "border-emerald-900 bg-emerald-950 text-emerald-400" },
	DISCONNECTED: { label: "Disconnected", className: "border-border bg-muted text-muted-foreground" },
	NO_DEVICE: { label: "No device", className: "border-amber-900 bg-amber-950 text-amber-400" },
	FAILED_TO_CONNECT: { label: "Cannot open", className: "border-destructive/40 bg-destructive/10 text-destructive" },
};

/**
 * One printer: what it is, whether it is reachable, and what can be done to it.
 *
 * **Offline disables; unpermitted hides.** The two look similar on screen and mean opposite
 * things. Offline is a state the operator can fix, and often the very thing they opened this card
 * to fix, so the button stays put with a reason under it — hiding it would make them wonder
 * whether the feature exists at all. Not holding `devices:pause` is not a state and there is
 * nothing to fix, so the button goes.
 */
export function DeviceCard({ device, permits }: { device: DeviceCardData; permits: DevicePermits }) {
	const [pending, startTransition] = useTransition();
	const connection = device.connection ? CONNECTION_STYLE[device.connection] : null;
	const online = device.agentOnline;
	const connected = device.connection === "CONNECTED";

	// The Configure dialog holds two separately-granted things: the printer's own settings, and its
	// variable overrides. Either one alone is reason enough to open it.
	const canConfigure = permits["devices:update"] || permits["devices:override"];

	// An operator holding devices:read alone gets no action row at all, rather than an empty strip
	// of padding where one used to be.
	const anyAction =
		canConfigure ||
		permits["devices:connect"] ||
		permits["devices:pause"] ||
		permits["devices:test-page"] ||
		permits["devices:clear-queue"] ||
		permits["devices:delete"];

	const act = (label: string, action: () => Promise<{ error: string | null }>): void => {
		startTransition(async () => {
			const result = await action();
			if (result.error) {
				toast.error(result.error);
			} else {
				toast.success(label);
			}
		});
	};

	return (
		<Card className="flex flex-col">
			<CardHeader className="flex flex-row items-center gap-3 border-b border-border pb-3">
				<Printer className="size-4.5 shrink-0 text-subtle-foreground" />
				<div className="min-w-0 flex-1">
					<div className="truncate font-mono text-[13.5px] font-medium">{device.name}</div>
					<div className="mt-0.5 truncate text-[11.5px] text-subtle-foreground">{device.agentName}</div>
				</div>
				<Badge
					variant="outline"
					className={`shrink-0 ${connection?.className ?? "border-border bg-muted text-muted-foreground"}`}
				>
					{connection?.label ?? "Unknown"}
				</Badge>
			</CardHeader>

			<CardContent className="flex flex-1 flex-col gap-4 pt-4">
				<dl className="grid grid-cols-2 gap-x-4 gap-y-3">
					<Detail label="Port" value={device.settings.port} />
					<Detail label="Baud" value={String(device.settings.baudRate)} />
					<Detail label="Columns" value={String(device.settings.columns)} />
					<Detail label="Codepage" value={device.settings.codepage} />
					<Detail label="Queue" value={device.queueDepth === null ? "—" : String(device.queueDepth)} />
					<Detail label="Printing" value={device.paused ? "Paused" : "Running"} />
				</dl>

				{!anyAction ? null : (
					/* `mt-0` because the offline note sits below this row. On `mt-auto` the row was pushed
					    down the card until it met the note, which left a gap above the buttons. */
					<CardActions className="mt-0 gap-2">
						{!permits["devices:connect"] ? null : (
							<Action
								title={connected ? "Close the port" : "Open the port"}
								disabled={!online || pending}
								pending={pending}
								onClick={() =>
									act(connected ? "Port closed." : "Port opened.", () => setConnected(device.id, !connected))
								}
							>
								{connected ? <PlugZap className="size-3.5" /> : <Plug className="size-3.5" />}
							</Action>
						)}

						{!permits["devices:pause"] ? null : (
							<Action
								title={device.paused ? "Resume printing" : "Pause printing"}
								disabled={!online || pending}
								pending={pending}
								onClick={() =>
									act(device.paused ? "Printing resumed." : "Printing paused.", () =>
										setPaused(device.id, !device.paused),
									)
								}
							>
								{device.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
							</Action>
						)}

						{!permits["devices:test-page"] ? null : (
							<Action
								title="Print a test page"
								disabled={!online || pending}
								pending={pending}
								onClick={() => act("Test page queued.", () => printTestPage(device.id))}
							>
								<FileText className="size-3.5" />
							</Action>
						)}

						{!permits["devices:clear-queue"] ? null : (
							<Action
								title="Cancel every waiting job"
								disabled={!online || pending}
								pending={pending}
								onClick={() => act("Queue cleared.", () => clearQueue(device.id))}
							>
								<Trash className="size-3.5" />
							</Action>
						)}

						<div className="flex-1" />

						{!canConfigure ? null : (
							<DeviceDialog
								agentId={device.agentId}
								agentName={device.agentName}
								agentOnline={online}
								deviceId={device.id}
								initial={device.settings}
								variables={device.variables}
								permits={permits}
								trigger={
									<Button
										variant="outline"
										size="icon"
										className="size-8"
										title={permits["devices:update"] ? "Configure" : "Variable overrides"}
										aria-label={permits["devices:update"] ? "Configure printer" : "Override this printer's variables"}
										disabled={pending}
									>
										<Settings2 className="size-3.5" />
									</Button>
								}
							/>
						)}

						{!permits["devices:delete"] ? null : (
							<AlertDialog>
								<AlertDialogTrigger
									disabled={pending}
									render={
										<Button
											variant="outline"
											size="icon"
											className="size-8 border-destructive/40 text-destructive hover:bg-destructive/10"
											title="Delete"
											aria-label="Delete printer"
										>
											<Trash2 className="size-3.5" />
										</Button>
									}
								/>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>Delete {device.name}?</AlertDialogTitle>
										<AlertDialogDescription>
											This also deletes its job history, and any API key grant that named it. This cannot be undone.
										</AlertDialogDescription>
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>Cancel</AlertDialogCancel>
										<AlertDialogAction onClick={() => act(`${device.name} deleted.`, () => deleteDevice(device.id))}>
											Delete
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						)}
					</CardActions>
				)}

				{!online ? (
					<p className="text-[11.5px] text-subtle-foreground">
						{device.agentName} is offline.{" "}
						{permits["devices:update"]
							? "Configuration can still be changed; it reaches the printer when the agent reconnects."
							: "Nothing can be sent to this printer until the agent reconnects."}
					</p>
				) : null}
			</CardContent>
		</Card>
	);
}

/**
 * An icon button in the action row.
 *
 * The spinner tracks work in flight, not the disabled state. A button disabled because the
 * agent is offline would otherwise spin forever, which reads as a request that never finishes.
 */
function Action({
	title,
	disabled,
	pending,
	onClick,
	children,
}: {
	title: string;
	disabled: boolean;
	pending: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<Button
			variant="outline"
			size="icon"
			className="size-8"
			title={title}
			aria-label={title}
			disabled={disabled}
			onClick={onClick}
		>
			{pending ? <Spinner className="size-3.5" /> : children}
		</Button>
	);
}

function Detail({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0">
			<dt className="text-[11px] font-medium text-subtle-foreground">{label}</dt>
			<dd className="mt-0.5 truncate font-mono text-[12.5px]">{value}</dd>
		</div>
	);
}
