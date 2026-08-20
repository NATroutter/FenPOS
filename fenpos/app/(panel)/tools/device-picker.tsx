"use client";

import { useEffect, useMemo } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** A printer as the tools list it. */
export interface ToolDevice {
	id: string;
	/** The machine the printer is attached to. */
	agentName: string;
	/** The printer's own name, unique only within its agent. */
	deviceName: string;
	/** Printable columns, so an example can be built at the width it will print at. */
	columns: number;
	/** The codepage it is configured for, named in the test page it produces. */
	codepage: string;
	online: boolean;
}

/**
 * Chooses which printer a tool acts on: first the machine, then the printer on it.
 *
 * Two dropdowns rather than one, because a single list of `agent/device` pairs grows with the
 * product of both and reads as a wall of near-identical strings — every site has a `kitchen`, and
 * the part that tells them apart is the prefix. Choosing the machine first cuts the second list to
 * the handful of printers actually on it.
 *
 * Selection is still one value: the device id. The agent is derived from it rather than held
 * separately, so the two dropdowns cannot disagree about what is selected. Changing the agent moves
 * the selection to that agent's first printer, which is the only device choice that is certainly
 * valid.
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
	const selected = devices.find((device) => device.id === value);

	// The tools restore their device from session storage, which outlives the printer it names: a
	// device deleted between two sittings comes back as an id nothing matches. Left alone that shows
	// an empty picker over a tool whose Print button is mysteriously disabled, so the selection is
	// moved to a printer that exists.
	useEffect(() => {
		if (!selected && devices.length > 0) {
			onChange(devices[0].id);
		}
	}, [selected, devices, onChange]);

	// Falls back to the first agent so the trigger is never blank in the frame before that runs.
	const agentName = selected?.agentName ?? devices[0]?.agentName ?? "";
	const onThisAgent = useMemo(() => devices.filter((device) => device.agentName === agentName), [devices, agentName]);

	// Base UI renders the raw value in the trigger unless the root is told what the values mean,
	// and a device's value is its id — so without this the picker showed a cuid.
	const agents = useMemo(() => [...new Set(devices.map((device) => device.agentName))], [devices]);
	const agentItems = useMemo(() => Object.fromEntries(agents.map((name) => [name, name])), [agents]);
	const deviceItems = useMemo(
		() => Object.fromEntries(onThisAgent.map((device) => [device.id, labelFor(device)])),
		[onThisAgent],
	);

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Select
				items={agentItems}
				value={agentName}
				onValueChange={(next) => {
					const first = devices.find((device) => device.agentName === next);
					if (first) {
						onChange(first.id);
					}
				}}
			>
				<SelectTrigger className="h-8 w-auto min-w-[150px] font-mono text-[12px]">
					<SelectValue placeholder="Agent" />
				</SelectTrigger>
				<SelectContent>
					{agents.map((name) => (
						<SelectItem key={name} value={name} className="font-mono text-[12px]">
							{name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			<Select items={deviceItems} value={value} onValueChange={(next) => next && onChange(next)}>
				<SelectTrigger className="h-8 w-auto min-w-[150px] font-mono text-[12px]">
					<SelectValue placeholder="Printer" />
				</SelectTrigger>
				<SelectContent>
					{onThisAgent.map((device) => (
						<SelectItem key={device.id} value={device.id} className="font-mono text-[12px]">
							{labelFor(device)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/** The name shown for a printer, which must match between the list and the trigger. */
function labelFor(device: ToolDevice): string {
	return device.online ? device.deviceName : `${device.deviceName} (offline)`;
}
