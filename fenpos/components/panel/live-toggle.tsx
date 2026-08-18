"use client";

import { Pause, Radio } from "lucide-react";
import { useLive } from "@/components/panel/event-stream";
import { Toggle } from "@/components/ui/toggle";

/**
 * The header's live/pause chip.
 *
 * Governs the panel's whole event subscription rather than the current tab's, so its state means
 * the same thing everywhere and an operator reading a failure on the Logs tab does not find the
 * Jobs tab still moving underneath them when they navigate back.
 *
 * It reads as a status chip and behaves as a switch, which is why it is a `Toggle` rather than a
 * `Badge`: the pressed state is the stream's state, so the control and the indicator are the same
 * element and cannot disagree.
 */
export function LiveToggle() {
	const { live, setLive } = useLive();

	return (
		<Toggle
			variant="outline"
			size="sm"
			pressed={live}
			onPressedChange={setLive}
			aria-label={live ? "Pause live updates" : "Resume live updates"}
			title={live ? "Live — click to pause updates" : "Paused — click to resume updates"}
			className="gap-1.5 font-mono text-[11.5px] tracking-tight"
		>
			{live ? <Radio className="text-emerald-400" /> : <Pause className="text-subtle-foreground" />}
			{live ? "live" : "paused"}
		</Toggle>
	);
}
