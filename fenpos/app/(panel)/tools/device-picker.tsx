"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** A printer as the tools list it. */
export interface ToolDevice {
	id: string;
	label: string;
	online: boolean;
}

/**
 * Chooses which printer a tool acts on.
 *
 * Offline printers stay in the list rather than being hidden. Composing a receipt for a printer
 * that is currently unplugged is a normal thing to do, and a name that vanished from the list
 * would read as a printer that had been deleted.
 */
export function DevicePicker({
	devices,
	value,
	onChange,
}: {
	devices: ToolDevice[];
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<Select value={value} onValueChange={(next) => next && onChange(next)}>
			<SelectTrigger className="h-8 w-auto min-w-[180px] font-mono text-[12px]">
				<SelectValue placeholder="Printer" />
			</SelectTrigger>
			<SelectContent>
				{devices.map((device) => (
					<SelectItem key={device.id} value={device.id} className="font-mono text-[12px]">
						{device.label}
						{device.online ? "" : " (offline)"}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
