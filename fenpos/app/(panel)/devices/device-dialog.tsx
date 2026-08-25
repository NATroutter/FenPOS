"use client";

import { RefreshCw } from "lucide-react";
import { type ReactElement, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { createDevice, saveDeviceOverride, scanAgentPorts, updateDevice } from "@/app/(panel)/devices/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
	Codepage,
	type Codepage as CodepageValue,
	FlowControl,
	type FlowControl as FlowControlValue,
	Linefeed,
	type Linefeed as LinefeedValue,
	Parity,
	type Parity as ParityValue,
	UnsupportedPolicy,
	type UnsupportedPolicy as UnsupportedPolicyValue,
} from "@/lib/domain/enums";
import { toNameCandidate } from "@/lib/domain/naming";
import type { SerialPortInfo } from "@/lib/link/protocol";

/** Baud rates offered. Anything else is unusual enough to warrant checking the printer manual. */
const BAUD_RATES = [2400, 4800, 9600, 19200, 38400, 57600, 115200] as const;

/** Column counts for the two paper widths a thermal receipt printer almost always uses. */
const COLUMN_PRESETS = [32, 42, 48] as const;

/** Everything a printer is configured with, as the form holds it. */
export interface DeviceFormValues {
	name: string;
	port: string;
	baudRate: number;
	dataBits: number;
	stopBits: number;
	parity: ParityValue;
	flowControl: FlowControlValue;
	writeTimeoutMs: number;
	autoConnect: boolean;
	autoReconnect: boolean;
	reconnectDelaySeconds: number;
	columns: number;
	codepage: CodepageValue;
	onUnsupported: UnsupportedPolicyValue;
	defaultWrap: boolean;
	defaultLinefeed: LinefeedValue;
	maxQueueDepth: number;
}

/**
 * One `STATIC` variable as this printer may override it.
 *
 * Only `STATIC` variables appear here at all — a `DATETIME` variable's format and a `CONTEXT`
 * variable's source are the same fact on every printer, so `setDeviceOverride` refuses them, and
 * the dialog never offers them in the first place.
 */
export interface OverridableVariable {
	id: string;
	name: string;
	/** The install-wide value, shown as placeholder text so the operator can see what they are replacing. */
	value: string;
	/** This printer's own value, or null when it falls back to the install-wide one. */
	override: string | null;
}

/** A printer as it arrives from the server, with defaults already applied. */
export const EMPTY_DEVICE: DeviceFormValues = {
	name: "",
	port: "",
	baudRate: 9600,
	dataBits: 8,
	stopBits: 1,
	parity: "NONE",
	flowControl: "NONE",
	writeTimeoutMs: 5000,
	autoConnect: true,
	autoReconnect: true,
	reconnectDelaySeconds: 5,
	columns: 42,
	codepage: "CP858",
	onUnsupported: "REJECT",
	defaultWrap: true,
	defaultLinefeed: "LF",
	maxQueueDepth: 100,
};

/**
 * Adds or edits one printer.
 *
 * **The port is chosen from a list the agent produced, not typed.** The operator configuring a
 * printer is usually not sitting at the machine it is plugged into, and a mistyped port name
 * fails as a device that simply never connects — indistinguishable from broken hardware, and
 * diagnosed nowhere near the typo. Typing one is still possible for a port that is not plugged
 * in yet, but the list is what the dialog leads with.
 */
export function DeviceDialog({
	agentId,
	agentName,
	agentOnline,
	deviceId,
	initial,
	variables = [],
	trigger,
}: {
	agentId: string;
	agentName: string;
	agentOnline: boolean;
	deviceId?: string;
	initial?: DeviceFormValues;
	/** This printer's `STATIC` variables, for the overrides section. Empty on the "Add printer" dialog, which has no `deviceId` yet to hang an override on. */
	variables?: OverridableVariable[];
	trigger: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	const [values, setValues] = useState<DeviceFormValues>(initial ?? EMPTY_DEVICE);
	const [error, setError] = useState<string | null>(null);
	const [ports, setPorts] = useState<SerialPortInfo[] | null>(null);
	const [scanError, setScanError] = useState<string | null>(null);
	const [scanning, startScan] = useTransition();
	const [saving, startSave] = useTransition();

	const set = <K extends keyof DeviceFormValues>(key: K, value: DeviceFormValues[K]): void => {
		setValues((current) => ({ ...current, [key]: value }));
	};

	const scan = (): void => {
		startScan(async () => {
			const result = await scanAgentPorts(agentId);
			setPorts(result.ports);
			setScanError(result.error);
		});
	};

	// Scanned as the dialog opens rather than behind a button the operator has to find. The
	// list is the point of the dialog; making them ask for it adds a step to every use.
	useEffect(() => {
		if (open && agentOnline && ports === null) {
			scan();
		}
	}, [open, agentOnline, ports]);

	const save = (): void => {
		setError(null);
		startSave(async () => {
			const input = { ...values, name: toNameCandidate(values.name) };
			const result = deviceId ? await updateDevice(deviceId, input) : await createDevice(agentId, input);

			if (result.error) {
				setError(result.error);
				return;
			}
			toast.success(deviceId ? `${input.name} saved.` : `${input.name} added to ${agentName}.`);
			setOpen(false);
			if (!deviceId) {
				setValues(EMPTY_DEVICE);
			}
		});
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setError(null);
				}
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-[820px]">
				<DialogHeader>
					<DialogTitle>{deviceId ? "Configure printer" : "Add printer"}</DialogTitle>
					<DialogDescription>
						On <span className="font-mono">{agentName}</span>. Serial settings must match what the printer expects; its
						manual or a label on the back usually says.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="flex flex-col gap-4">
						<Field>
							<FieldLabel htmlFor="device-name">Name</FieldLabel>
							<Input
								id="device-name"
								value={values.name}
								disabled={saving}
								placeholder="kitchen"
								onChange={(event) => set("name", toNameCandidate(event.target.value, { keepTrailingSeparator: true }))}
							/>
							<FieldDescription>
								Used in the print API path, so it is a slug. Unique within this agent only — another site can have its
								own <span className="font-mono">kitchen</span>.
							</FieldDescription>
						</Field>

						<Field>
							<FieldLabel htmlFor="device-port">Serial port</FieldLabel>
							<div className="flex gap-2">
								<Input
									id="device-port"
									value={values.port}
									disabled={saving}
									placeholder="COM3 or /dev/ttyUSB0"
									className="font-mono"
									onChange={(event) => set("port", event.target.value)}
								/>
								<Button
									type="button"
									variant="outline"
									size="icon"
									title="Rescan ports"
									aria-label="Rescan ports"
									disabled={!agentOnline || scanning || saving}
									onClick={scan}
								>
									{scanning ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
								</Button>
							</div>

							{!agentOnline ? (
								<FieldDescription>
									{agentName} is offline, so its ports cannot be listed. Type the port if you know it.
								</FieldDescription>
							) : scanError ? (
								<FieldDescription className="text-destructive">{scanError}</FieldDescription>
							) : ports && ports.length > 0 ? (
								<div className="flex flex-wrap gap-1.5 pt-1">
									{ports.map((port) => (
										<Button
											key={port.name}
											type="button"
											variant={values.port === port.name ? "default" : "outline"}
											size="sm"
											className="h-7 font-mono text-[11.5px]"
											disabled={saving}
											onClick={() => set("port", port.name)}
											title={`${port.description}${port.serialNumber ? ` · ${port.serialNumber}` : ""}`}
										>
											{port.name}
										</Button>
									))}
								</div>
							) : ports ? (
								<FieldDescription>{agentName} reports no serial ports. Is the printer plugged in?</FieldDescription>
							) : (
								<FieldDescription>Listing ports on {agentName}…</FieldDescription>
							)}
						</Field>

						<div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
							<Choice
								label="Baud rate"
								value={String(values.baudRate)}
								options={BAUD_RATES.map((rate) => String(rate))}
								disabled={saving}
								onChange={(next) => set("baudRate", Number(next))}
							/>
							<Choice
								label="Columns"
								value={String(values.columns)}
								options={COLUMN_PRESETS.map((columns) => String(columns))}
								disabled={saving}
								onChange={(next) => set("columns", Number(next))}
								description="42 for 80mm paper, 32 for 58mm."
							/>
							<Choice
								label="Codepage"
								value={values.codepage}
								options={[...Codepage.values]}
								disabled={saving}
								onChange={(next) => set("codepage", next as CodepageValue)}
							/>
							<Choice
								label="Parity"
								value={values.parity}
								options={[...Parity.values]}
								disabled={saving}
								onChange={(next) => set("parity", next as ParityValue)}
							/>
							<Choice
								label="Flow control"
								value={values.flowControl}
								options={[...FlowControl.values]}
								disabled={saving}
								onChange={(next) => set("flowControl", next as FlowControlValue)}
							/>
							<Choice
								label="Data bits"
								value={String(values.dataBits)}
								options={["5", "6", "7", "8"]}
								disabled={saving}
								onChange={(next) => set("dataBits", Number(next))}
							/>
							<Choice
								label="Stop bits"
								value={String(values.stopBits)}
								options={["1", "2"]}
								disabled={saving}
								onChange={(next) => set("stopBits", Number(next))}
							/>
							<Choice
								label="Line ending"
								value={values.defaultLinefeed}
								options={[...Linefeed.values]}
								disabled={saving}
								onChange={(next) => set("defaultLinefeed", next as LinefeedValue)}
							/>
							<Choice
								label="Unsupported characters"
								value={values.onUnsupported}
								options={[...UnsupportedPolicy.values]}
								disabled={saving}
								onChange={(next) => set("onUnsupported", next as UnsupportedPolicyValue)}
								description="What to do with a character the codepage cannot print."
							/>
							<NumberField
								label="Queue depth"
								value={values.maxQueueDepth}
								disabled={saving}
								onChange={(next) => set("maxQueueDepth", next)}
								description="Jobs the agent will hold before refusing more."
							/>
							<NumberField
								label="Write timeout (ms)"
								value={values.writeTimeoutMs}
								disabled={saving}
								onChange={(next) => set("writeTimeoutMs", next)}
							/>
							<NumberField
								label="Reconnect delay (s)"
								value={values.reconnectDelaySeconds}
								disabled={saving}
								onChange={(next) => set("reconnectDelaySeconds", next)}
							/>
						</div>

						<div className="flex flex-col gap-2.5 border-t border-border pt-3">
							<Toggle
								id="device-auto-connect"
								label="Open the port automatically"
								checked={values.autoConnect}
								disabled={saving}
								onChange={(next) => set("autoConnect", next)}
							/>
							<Toggle
								id="device-auto-reconnect"
								label="Reopen it if the printer disappears"
								checked={values.autoReconnect}
								disabled={saving}
								onChange={(next) => set("autoReconnect", next)}
							/>
							<Toggle
								id="device-default-wrap"
								label="Wrap long lines to the paper width"
								checked={values.defaultWrap}
								disabled={saving}
								onChange={(next) => set("defaultWrap", next)}
							/>
						</div>

						{deviceId ? <OverridesSection deviceId={deviceId} variables={variables} disabled={saving} /> : null}

						{error ? (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
					</div>
				</DialogBody>
				<DialogFooter>
					<Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button type="button" disabled={saving || values.name === "" || values.port === ""} onClick={save}>
						{saving ? <Spinner className="size-3.5" /> : null}
						{deviceId ? "Save" : "Add printer"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** A labelled select over a closed set of values. */
function Choice({
	label,
	value,
	options,
	disabled,
	onChange,
	description,
}: {
	label: string;
	value: string;
	options: string[];
	disabled: boolean;
	onChange: (value: string) => void;
	description?: string;
}) {
	return (
		<Field>
			<FieldLabel>{label}</FieldLabel>
			<Select
				value={value}
				disabled={disabled}
				onValueChange={(next) => {
					if (next !== null) {
						onChange(next);
					}
				}}
			>
				<SelectTrigger className="font-mono">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option} value={option} className="font-mono">
							{option}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{description ? <FieldDescription>{description}</FieldDescription> : null}
		</Field>
	);
}

/** A labelled whole-number input. */
function NumberField({
	label,
	value,
	disabled,
	onChange,
	description,
}: {
	label: string;
	value: number;
	disabled: boolean;
	onChange: (value: number) => void;
	description?: string;
}) {
	return (
		<Field>
			<FieldLabel>{label}</FieldLabel>
			<Input
				type="number"
				className="font-mono"
				value={value}
				disabled={disabled}
				onChange={(event) => onChange(Number.parseInt(event.target.value, 10) || 0)}
			/>
			{description ? <FieldDescription>{description}</FieldDescription> : null}
		</Field>
	);
}

/** A labelled checkbox. */
function Toggle({
	id,
	label,
	checked,
	disabled,
	onChange,
}: {
	id: string;
	label: string;
	checked: boolean;
	disabled: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<div className="flex items-center gap-2.5">
			<Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(next) => onChange(next === true)} />
			<FieldLabel htmlFor={id} className="cursor-pointer text-[12.5px] font-normal">
				{label}
			</FieldLabel>
		</div>
	);
}

/**
 * Lets this one printer carry its own value for a `STATIC` variable, in place of the install-wide
 * one every other printer sees.
 *
 * Only shown once the printer already exists — `deviceId` has to name a real row for an override
 * to hang off of, which is why the "Add printer" dialog never renders this at all. Each field saves
 * itself independently of the dialog's own Save button: an override is a separate write against a
 * separate table, and batching it behind "Save" would mean losing it if the operator closed the
 * dialog with Cancel after only meaning to skip the serial settings they hadn't touched.
 */
function OverridesSection({
	deviceId,
	variables,
	disabled,
}: {
	deviceId: string;
	variables: OverridableVariable[];
	disabled: boolean;
}) {
	return (
		<div className="flex flex-col gap-2.5 border-t border-border pt-3">
			<div>
				<FieldLabel>Variable overrides</FieldLabel>
				<FieldDescription>
					A date's format and a printer's own name are the same on every printer, so only text variables can be
					overridden here.
				</FieldDescription>
			</div>

			{variables.length === 0 ? (
				<p className="text-[11.5px] text-subtle-foreground">
					No text variables are defined yet. Add one on the Variables tab to override it here.
				</p>
			) : (
				<div className="grid grid-cols-2 gap-4">
					{variables.map((variable) => (
						<OverrideField key={variable.id} deviceId={deviceId} variable={variable} disabled={disabled} />
					))}
				</div>
			)}
		</div>
	);
}

/**
 * One variable's field in {@link OverridesSection}.
 *
 * Saves on blur rather than on every keystroke, the same tradeoff the serial fields above make by
 * waiting for the dialog's own Save — a value is not this printer's until the operator has finished
 * typing it, and a save per character would spam `setDeviceOverride` for nothing. Clearing the box
 * and moving on saves `null`, which removes the override and falls back to the install-wide value
 * shown as the box's placeholder.
 */
function OverrideField({
	deviceId,
	variable,
	disabled,
}: {
	deviceId: string;
	variable: OverridableVariable;
	disabled: boolean;
}) {
	const [draft, setDraft] = useState(variable.override ?? "");
	const [saving, startSaving] = useTransition();

	// Re-syncs the box when the server's own value moves for a reason this field did not cause —
	// another tab's edit landing after `revalidatePath`, or the dialog reopening on a different
	// printer's data while this component happens to stay mounted.
	useEffect(() => {
		setDraft(variable.override ?? "");
	}, [variable.override]);

	const commit = (): void => {
		const next = draft === "" ? null : draft;
		if (next === variable.override) {
			return;
		}
		startSaving(async () => {
			const result = await saveDeviceOverride(deviceId, variable.id, next);
			if (result.error) {
				toast.error(result.error);
				setDraft(variable.override ?? "");
			}
		});
	};

	return (
		<Field>
			<FieldLabel htmlFor={`override-${variable.id}`} className="font-mono">
				{variable.name}
			</FieldLabel>
			<Input
				id={`override-${variable.id}`}
				value={draft}
				placeholder={variable.value}
				disabled={disabled || saving}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
			/>
		</Field>
	);
}
