import { Plus, Printer, Server } from "lucide-react";
import { DeviceCard, type DeviceCardData } from "@/app/(panel)/devices/device-card";
import { DeviceDialog, EMPTY_DEVICE } from "@/app/(panel)/devices/device-dialog";
import { LiveRefresh } from "@/components/panel/live-refresh";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/db";
import type { Codepage, FlowControl, Linefeed, Parity, UnsupportedPolicy } from "@/lib/domain/enums";
import { getAgentStatus } from "@/lib/link/device-status";
import { isConnected } from "@/lib/link/registry";
import { listDeviceOverrides, listVariables } from "@/lib/variables/variable-service";

export const metadata = { title: "Devices" };

/**
 * Never cached: connection state and queue depth change without any request causing it to.
 */
export const dynamic = "force-dynamic";

/**
 * The Devices tab.
 *
 * Grouped by agent, because that is the physical reality: a printer belongs to one machine, its
 * name is unique only within that machine, and every action on it goes through that machine's
 * link. A flat list would let an operator act on a printer without noticing which site it is at.
 *
 * Configured state comes from the database; observed state comes from what each agent last
 * reported. Keeping the two visibly separate is the point — a printer configured to auto-connect
 * and currently unplugged is a normal, temporary situation, and the panel should show both facts
 * rather than resolving them into one misleading answer.
 */
export default async function DevicesPage() {
	// Outside any try: both an absent session and a refusal signal by throwing.
	await requirePagePermission("devices:read", "/devices");

	const [agents, variables] = await Promise.all([
		prisma.agent.findMany({
			orderBy: { name: "asc" },
			include: { devices: { orderBy: { name: "asc" } } },
		}),
		listVariables(),
	]);

	// Only a `STATIC` variable can carry a per-printer value — `setDeviceOverride` refuses any
	// other kind, since a date's format or a job's own name is the same fact on every printer. This
	// filters here rather than in the dialog so a device with no `STATIC` variables at all never
	// asks the panel to render an override row for one it could not save anyway.
	const staticVariables = variables.filter((variable) => variable.kind === "STATIC");

	const groups = await Promise.all(
		agents.map(async (agent) => {
			const online = isConnected(agent.id);
			const observed = getAgentStatus(agent.id);

			const devices: DeviceCardData[] = await Promise.all(
				agent.devices.map(async (device) => {
					const state = observed.get(device.name);
					const overrides = await listDeviceOverrides(device.id);
					return {
						id: device.id,
						agentId: agent.id,
						agentName: agent.name,
						agentOnline: online,
						name: device.name,
						paused: device.paused,
						connection: state?.connection ?? null,
						queueDepth: state?.queueDepth ?? null,
						settings: {
							name: device.name,
							port: device.port,
							baudRate: device.baudRate,
							dataBits: device.dataBits,
							stopBits: device.stopBits,
							// SQLite has no enums, so Prisma types these as plain strings. The values are
							// written only through the device service, which validates them against the same
							// closed sets, and a row that somehow held anything else would be refused by the
							// config push long before it reached a printer.
							parity: device.parity as Parity,
							flowControl: device.flowControl as FlowControl,
							writeTimeoutMs: device.writeTimeoutMs,
							autoConnect: device.autoConnect,
							autoReconnect: device.autoReconnect,
							reconnectDelaySeconds: device.reconnectDelaySeconds,
							columns: device.columns,
							codepage: device.codepage as Codepage,
							onUnsupported: device.onUnsupported as UnsupportedPolicy,
							defaultWrap: device.defaultWrap,
							defaultLinefeed: device.defaultLinefeed as Linefeed,
							maxQueueDepth: device.maxQueueDepth ?? EMPTY_DEVICE.maxQueueDepth,
						},
						variables: staticVariables.map((variable) => ({
							id: variable.id,
							name: variable.name,
							// `STATIC` guarantees `value` is set — `variableDefinitionSchema` refuses a
							// `STATIC` row without one — so this never falls back in practice.
							value: variable.value ?? "",
							override: overrides.get(variable.name) ?? null,
						})),
					};
				}),
			);

			return { id: agent.id, name: agent.name, online, devices };
		}),
	);

	const total = groups.reduce((count, group) => count + group.devices.length, 0);

	return (
		<div className="flex flex-col gap-5">
			<LiveRefresh kinds={["agent", "device"]} />
			{agents.length === 0 ? (
				<Empty className="border border-dashed border-border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Printer />
						</EmptyMedia>
						<EmptyTitle>No agents yet</EmptyTitle>
						<EmptyDescription>
							Printers are configured behind an agent. Add one on the Agents tab and pair it first.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				groups.map((group) => (
					// An agent is a heading with a rule under it, not a card. The grouping is real — a
					// printer belongs to one machine and every action on it goes through that machine's
					// link — but drawing it as a box put cards inside a card, and two nested surfaces
					// compete for the same "this is an object" reading rather than one containing the
					// other. A rule says "everything below this belongs to that name" without claiming
					// to be an object at all.
					<section key={group.id} className="flex flex-col gap-4">
						<div className="flex flex-wrap items-center gap-3 border-b border-border pb-3">
							<Server className="size-4.5 shrink-0 text-subtle-foreground" />
							<h3 className="font-mono text-[13px] font-medium">{group.name}</h3>
							<span className="text-[11.5px] text-subtle-foreground">
								{group.online ? "online" : "offline"} · {group.devices.length}{" "}
								{group.devices.length === 1 ? "printer" : "printers"}
							</span>
							<div className="flex-1" />
							<DeviceDialog
								agentId={group.id}
								agentName={group.name}
								agentOnline={group.online}
								trigger={
									<Button variant="outline" size="sm" className="h-8">
										<Plus className="size-3.5" />
										Add printer
									</Button>
								}
							/>
						</div>

						{group.devices.length === 0 ? (
							<p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[12.5px] text-subtle-foreground">
								No printers on {group.name} yet.
							</p>
						) : (
							<div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] items-stretch gap-4">
								{group.devices.map((device) => (
									<DeviceCard key={device.id} device={device} />
								))}
							</div>
						)}
					</section>
				))
			)}

			{agents.length > 0 && total === 0 ? (
				<p className="text-[12.5px] text-subtle-foreground">
					Add a printer to an agent above, then use its test page to check the paper width and codepage.
				</p>
			) : null}
		</div>
	);
}
