"use client";

import { type ReactElement, useState, useTransition } from "react";
import { toast } from "sonner";
import { createKey, updateKey } from "@/app/(panel)/keys/actions";
import { SecretPane } from "@/app/(panel)/keys/secret-pane";
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
import { Spinner } from "@/components/ui/spinner";
import { PERMISSIONS } from "@/lib/domain/permissions";

/** A printer a key can be granted, as the dialog lists it. */
export interface GrantableDevice {
	id: string;
	name: string;
	agentName: string;
}

/**
 * Creates a key, or edits an existing key's grants.
 *
 * **A new key's secret is shown once, here, and never again.** The database holds only a hash, so
 * there is no route back to it — not as a precaution but by construction. The dialog therefore
 * refuses to close on its own after minting: an operator who navigated away mid-copy would have
 * to revoke the key and start over, so the dismissal has to be deliberate.
 */
export function KeyDialog({
	devices,
	keyId,
	initialName,
	initialPermissions,
	initialDeviceIds,
	trigger,
}: {
	devices: GrantableDevice[];
	keyId?: string;
	initialName?: string;
	initialPermissions?: string[];
	initialDeviceIds?: string[];
	trigger: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState(initialName ?? "");
	const [permissions, setPermissions] = useState<string[]>(initialPermissions ?? []);
	const [deviceIds, setDeviceIds] = useState<string[]>(initialDeviceIds ?? []);
	const [error, setError] = useState<string | null>(null);
	const [secret, setSecret] = useState<string | null>(null);
	const [saving, startSave] = useTransition();

	const toggle = (list: string[], value: string): string[] =>
		list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

	const save = (): void => {
		setError(null);
		startSave(async () => {
			if (keyId) {
				const result = await updateKey(keyId, permissions, deviceIds);
				if (result.error) {
					setError(result.error);
					return;
				}
				toast.success("Key updated.");
				setOpen(false);
				return;
			}

			const result = await createKey(name, permissions, deviceIds);
			if (result.error || !result.secret) {
				setError(result.error ?? "Could not create the key.");
				return;
			}
			setSecret(result.secret);
		});
	};

	// Dismissing only closes. It deliberately does not touch `secret`, which chooses between the
	// two panes below: clearing it here would swap the secret pane for the creation form and then
	// play the closing animation on *that*, so dismissing a freshly minted key flashed the form
	// it was created from on the way out.
	const close = (): void => {
		setOpen(false);
	};

	/** Returns the dialog to its opening state. Safe to call more than once. */
	const reset = (): void => {
		setError(null);
		setSecret(null);
		if (!keyId) {
			setName("");
			setPermissions([]);
			setDeviceIds([]);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				// Also on the way in, because reopening within the closing animation's 100ms never
				// reaches the handler below and would otherwise reveal the last secret again.
				if (next) {
					reset();
				}
			}}
			// After the animation rather than at the click, so the pane being faded out is the one
			// that was on screen when it was dismissed.
			onOpenChangeComplete={(nowOpen) => {
				if (!nowOpen) {
					reset();
				}
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-[560px]">
				{secret ? (
					<>
						<DialogHeader>
							<DialogTitle>Copy this key now</DialogTitle>
							<DialogDescription>
								It is stored as a hash and cannot be shown again. If you lose it, revoke this key and create another.
							</DialogDescription>
						</DialogHeader>
						<DialogBody>
							<SecretPane secret={secret} />
						</DialogBody>
						<DialogFooter>
							<Button type="button" onClick={close}>
								Done
							</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>{keyId ? "Edit key" : "New API key"}</DialogTitle>
							<DialogDescription>
								A key can do nothing until it is granted both a permission and a printer. Both lists start empty on
								purpose.
							</DialogDescription>
						</DialogHeader>
						<DialogBody>
							<div className="flex flex-col gap-4">
								{keyId ? null : (
									<Field>
										<FieldLabel htmlFor="key-name">Name</FieldLabel>
										<Input
											id="key-name"
											value={name}
											disabled={saving}
											placeholder="Till software"
											onChange={(event) => setName(event.target.value)}
										/>
										<FieldDescription>Shown in the panel and in job history. Free text.</FieldDescription>
									</Field>
								)}

								<div className="flex flex-col gap-2.5">
									<span className="text-[12.5px] font-medium">Permissions</span>
									{PERMISSIONS.map((permission) => (
										<div key={permission.id} className="flex items-start gap-2.5">
											<Checkbox
												id={`permission-${permission.id}`}
												className="mt-0.5"
												checked={permissions.includes(permission.id)}
												disabled={saving}
												onCheckedChange={() => setPermissions((current) => toggle(current, permission.id))}
											/>
											<FieldLabel htmlFor={`permission-${permission.id}`} className="cursor-pointer font-normal">
												<span className="font-mono text-[12px]">{permission.id}</span>
												<span className="block text-[11.5px] font-normal text-subtle-foreground">
													{permission.description}
												</span>
											</FieldLabel>
										</div>
									))}
								</div>

								<div className="flex flex-col gap-2.5 border-t border-border pt-3">
									<span className="text-[12.5px] font-medium">Printers</span>
									{devices.length === 0 ? (
										<p className="text-[11.5px] text-subtle-foreground">
											No printers configured yet. Add one on the Devices tab first.
										</p>
									) : (
										devices.map((device) => (
											<div key={device.id} className="flex items-center gap-2.5">
												<Checkbox
													id={`device-${device.id}`}
													checked={deviceIds.includes(device.id)}
													disabled={saving}
													onCheckedChange={() => setDeviceIds((current) => toggle(current, device.id))}
												/>
												<FieldLabel htmlFor={`device-${device.id}`} className="cursor-pointer font-normal">
													<span className="font-mono text-[12px]">
														{device.agentName}/{device.name}
													</span>
												</FieldLabel>
											</div>
										))
									)}
								</div>

								{error ? (
									<Alert variant="destructive">
										<AlertDescription>{error}</AlertDescription>
									</Alert>
								) : null}
							</div>
						</DialogBody>
						<DialogFooter>
							<Button type="button" variant="outline" disabled={saving} onClick={close}>
								Cancel
							</Button>
							<Button type="button" disabled={saving || (!keyId && name.trim() === "")} onClick={save}>
								{saving ? <Spinner className="size-3.5" /> : null}
								{keyId ? "Save" : "Create key"}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
