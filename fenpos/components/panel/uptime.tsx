"use client";

import { useEffect, useState } from "react";

/**
 * Formats a duration the way an operator reads it at a glance.
 *
 * Days are shown only once there are any, so a server up for four minutes reads `4m 12s`
 * rather than `0d 0h 4m`.
 *
 * @param milliseconds elapsed time
 * @returns a compact duration such as `3d 4h 12m` or `4m 12s`
 */
function formatUptime(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;

	if (days > 0) {
		return `${days}d ${hours}h ${minutes}m`;
	}
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m ${seconds}s`;
}

/**
 * A live uptime counter.
 *
 * The elapsed time is computed on the client from a server-supplied start timestamp rather
 * than rendered on the server, because a server-rendered duration is stale the moment it
 * arrives and would differ between the initial HTML and the first hydration.
 *
 * Rendering starts empty and fills in after mount for the same reason: the server has no
 * correct value to emit, and emitting a nearly-correct one produces a hydration mismatch.
 */
export function Uptime({ startedAt }: { startedAt: number }) {
	const [label, setLabel] = useState<string | null>(null);

	useEffect(() => {
		const update = () => setLabel(formatUptime(Date.now() - startedAt));
		update();

		const timer = setInterval(update, 1000);
		return () => clearInterval(timer);
	}, [startedAt]);

	return (
		<div className="mt-0.5 font-mono text-[12.5px] tabular-nums">
			{label ?? <span className="text-subtle-foreground">—</span>}
		</div>
	);
}
