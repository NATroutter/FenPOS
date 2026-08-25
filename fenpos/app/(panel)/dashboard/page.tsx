import { Activity, AlertTriangle, Printer, Server } from "lucide-react";
import Link from "next/link";
import { dashboardStatLabel } from "@/app/(panel)/dashboard/prose";
import { FollowProvider } from "@/app/(panel)/logs/follow";
import { LogStream } from "@/app/(panel)/logs/log-stream";
import { LiveRefresh } from "@/components/panel/live-refresh";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/db";
import { countJobsByStatus } from "@/lib/jobs/job-service";
import { getAgentStatus } from "@/lib/link/device-status";
import { isConnected } from "@/lib/link/registry";
import { listLogs } from "@/lib/logs/log-service";
import { integerSetting } from "@/lib/settings/settings-service";

export const metadata = { title: "Dashboard" };

/** Never cached: everything on this page changes without a request causing it. */
export const dynamic = "force-dynamic";

/**
 * The Dashboard.
 *
 * Answers one question — is anything wrong right now — and leads to the tab that answers the
 * follow-up. Everything here is either a count or a state; anything needing a filter belongs on
 * Jobs or Logs, because a dashboard that has to be interrogated is not doing its job.
 *
 * Reachability is read from the in-memory registry rather than the stored column. The column is
 * written when an agent connects and disconnects, but a process that died without running its
 * close handlers would leave it stale, and showing a printer as reachable when it is not is the
 * failure worth avoiding here.
 */
export default async function DashboardPage() {
	// Outside any try: both an absent session and a refusal signal by throwing.
	await requirePagePermission("dashboard:read");

	const [windowHours, tailLines] = await Promise.all([
		integerSetting("panel.dashboardWindowHours"),
		integerSetting("panel.dashboardTailLines"),
	]);
	const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

	const [agents, devices, counts, tail] = await Promise.all([
		prisma.agent.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
		prisma.device.findMany({
			orderBy: [{ agent: { name: "asc" } }, { name: "asc" }],
			select: { id: true, name: true, agentId: true, paused: true, agent: { select: { name: true } } },
		}),
		countJobsByStatus(since),
		listLogs({ take: tailLines }),
	]);

	const online = agents.filter((agent) => isConnected(agent.id));

	const printers = devices.map((device) => {
		const observed = getAgentStatus(device.agentId).get(device.name);
		return {
			id: device.id,
			label: `${device.agent.name}/${device.name}`,
			online: isConnected(device.agentId),
			connection: observed?.connection ?? null,
			paused: device.paused,
			queueDepth: observed?.queueDepth ?? null,
		};
	});

	// "Ready" is deliberately strict: reachable agent, open port, not paused. Anything short of
	// that will not print right now, and softening the definition would make the number reassuring
	// rather than useful.
	const ready = printers.filter((p) => p.online && p.connection === "CONNECTED" && !p.paused);
	const troubled = printers.filter((p) => !ready.includes(p));

	return (
		<div className="flex flex-col gap-5">
			{/* Not "log": the activity list below is a LogStream, which takes those itself. */}
			<LiveRefresh kinds={["agent", "device", "job"]} />
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<Stat
					icon={<Server className="size-3.5" />}
					label="Agents online"
					value={`${online.length}/${agents.length}`}
					href="/agents"
					warn={agents.length > 0 && online.length < agents.length}
				/>
				<Stat
					icon={<Printer className="size-3.5" />}
					label="Printers ready"
					value={`${ready.length}/${printers.length}`}
					href="/devices"
					warn={troubled.length > 0}
				/>
				<Stat
					label={dashboardStatLabel("Printed", windowHours)}
					value={String(counts.COMPLETED)}
					href="/jobs?status=COMPLETED"
				/>
				<Stat
					icon={counts.FAILED > 0 ? <AlertTriangle className="size-3.5" /> : undefined}
					label={dashboardStatLabel("Failed", windowHours)}
					value={String(counts.FAILED)}
					href="/jobs?status=FAILED"
					warn={counts.FAILED > 0}
				/>
			</div>

			<div className="grid gap-4 lg:grid-cols-2">
				<Card>
					<CardHeader className="flex flex-row items-center gap-2 border-b border-border pb-3">
						<Activity className="size-4.5 shrink-0 text-subtle-foreground" />
						<h3 className="text-[13px] font-medium">In flight</h3>
					</CardHeader>
					<CardContent className="pt-4">
						<dl className="grid grid-cols-3 gap-4">
							<Count label="Queued" value={counts.QUEUED} />
							<Count label="Printing" value={counts.PRINTING} />
							<Count label="Cancelled" value={counts.CANCELLED} />
						</dl>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center gap-2 border-b border-border pb-3">
						<AlertTriangle className="size-4.5 shrink-0 text-subtle-foreground" />
						<h3 className="text-[13px] font-medium">Printers needing attention</h3>
					</CardHeader>
					<CardContent className="pt-4">
						{printers.length === 0 ? (
							<p className="text-[12px] text-subtle-foreground">
								No printers configured yet. Add one on the Devices tab.
							</p>
						) : troubled.length === 0 ? (
							<p className="text-[12px] text-emerald-400">Every printer is connected and running.</p>
						) : (
							<ul className="flex flex-col gap-2">
								{troubled.map((printer) => (
									<li key={printer.id} className="flex items-center gap-2">
										<span className="font-mono text-[12px]">{printer.label}</span>
										<Badge variant="outline" className="border-amber-900 bg-amber-950 text-amber-400">
											{describe(printer)}
										</Badge>
									</li>
								))}
							</ul>
						)}
					</CardContent>
				</Card>
			</div>

			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-3">
					<h3 className="text-[13px] font-medium">Recent activity</h3>
					<Link href="/logs" className="text-[11.5px] text-muted-foreground underline-offset-2 hover:underline">
						All logs
					</Link>
				</div>
				{/* The dashboard tail carries no Follow control of its own: it is a glance rather than a
				    reading surface, and the header chip already governs whether anything streams. The
				    provider is here only because the stream reads its answer from context. */}
				<FollowProvider streamable>
					<LogStream lines={tail.lines} sortable={false} />
				</FollowProvider>
			</div>
		</div>
	);
}

/** Says, in a few words, why a printer is not ready. */
function describe(printer: { online: boolean; connection: string | null; paused: boolean }): string {
	if (!printer.online) {
		return "offline";
	}
	if (printer.paused) {
		return "paused";
	}
	if (printer.connection === null) {
		return "not reported";
	}
	return printer.connection.toLowerCase().replace(/_/g, " ");
}

/** One headline number, linking to the tab that explains it. */
function Stat({
	icon,
	label,
	value,
	href,
	warn,
}: {
	icon?: React.ReactNode;
	label: string;
	value: string;
	href: string;
	warn?: boolean;
}) {
	return (
		<Link href={href} className="rounded-md border border-border bg-card p-4 transition-colors hover:border-ring">
			<div className="flex items-center gap-1.5 text-[11.5px] text-subtle-foreground">
				{icon}
				{label}
			</div>
			<div className={`mt-1 font-mono text-[22px] ${warn ? "text-amber-400" : ""}`}>{value}</div>
		</Link>
	);
}

function Count({ label, value }: { label: string; value: number }) {
	return (
		<div>
			<dt className="text-[11px] font-medium text-subtle-foreground">{label}</dt>
			<dd className="mt-0.5 font-mono text-[18px]">{value}</dd>
		</div>
	);
}
