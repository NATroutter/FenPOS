"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useEventStream } from "@/components/panel/event-stream";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import type { LogLevel } from "@/lib/domain/enums";
import type { LogLine } from "@/lib/logs/log-service";

/** Chip styling per severity. */
const LEVEL_STYLE: Record<LogLevel, string> = {
	DEBUG: "border-border bg-muted text-subtle-foreground",
	INFO: "border-border bg-muted text-muted-foreground",
	WARN: "border-amber-900 bg-amber-950 text-amber-400",
	ERROR: "border-destructive/40 bg-destructive/10 text-destructive",
};

/**
 * The log, with new lines arriving as they are recorded.
 *
 * **New lines are prepended in place rather than triggering a page refresh.** A log that reloaded
 * on every line would be unreadable during the exact situation it exists for — a printer failing
 * repeatedly — because the list would jump under the cursor several times a second. Appending to
 * what is already rendered keeps scroll position and keeps the page cheap.
 *
 * Live lines are not filtered client-side. They arrive already narrowed by nothing, so a stream
 * showing lines the current filter excludes would be lying about what the filter means; instead
 * the stream is paused whenever a filter is set and the operator refreshes deliberately.
 */
export function LogStream({ lines, live }: { lines: LogLine[]; live: boolean }) {
	const router = useRouter();
	const [arrived, setArrived] = useState<LogLine[]>([]);

	// Lines that arrived live are dropped whenever the server sends a new page, since that page
	// already contains them. Without this they would appear twice after any navigation.
	useEffect(() => {
		setArrived([]);
	}, [lines]);

	useEventStream(
		"log",
		(event) => {
			const payload = JSON.parse(event.data);
			setArrived((current) => [
				{
					id: payload.id,
					at: payload.at,
					level: payload.level,
					message: payload.message,
					agentName: null,
					deviceName: payload.deviceName,
				},
				...current,
			]);
		},
		live,
	);

	const all = [...arrived, ...lines];

	if (all.length === 0) {
		return (
			<Empty className="border border-dashed border-border">
				<EmptyHeader>
					<EmptyTitle>No log lines</EmptyTitle>
					<EmptyDescription>
						Agents forward what an operator would act on — jobs accepted and refused, ports opened and refused. Nothing
						has happened yet.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			{arrived.length > 0 ? (
				<div className="flex items-center gap-2 text-[11.5px] text-subtle-foreground">
					<span>
						{arrived.length} new {arrived.length === 1 ? "line" : "lines"}
					</span>
					<Button variant="ghost" size="sm" className="h-6 text-[11.5px]" onClick={() => router.refresh()}>
						Reload
					</Button>
				</div>
			) : null}

			<div className="overflow-x-auto rounded-md border border-border">
				<div className="min-w-[640px] divide-y divide-border">
					{all.map((line) => (
						<div key={line.id} className="flex items-start gap-3 px-3 py-2">
							<span className="w-[150px] shrink-0 font-mono text-[11px] text-subtle-foreground">
								{new Date(line.at).toLocaleString()}
							</span>
							<Badge variant="outline" className={`w-[62px] shrink-0 justify-center ${LEVEL_STYLE[line.level]}`}>
								{line.level.toLowerCase()}
							</Badge>
							<span className="w-[150px] shrink-0 truncate font-mono text-[11px] text-subtle-foreground">
								{line.agentName ?? "—"}
								{line.deviceName ? `/${line.deviceName}` : ""}
							</span>
							<span className="min-w-0 flex-1 text-[12px]">{line.message}</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
