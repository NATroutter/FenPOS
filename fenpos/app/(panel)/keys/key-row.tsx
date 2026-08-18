"use client";

import { Ban, Settings2, Trash2 } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { deleteKey, revokeKey } from "@/app/(panel)/keys/actions";
import { type GrantableDevice, KeyDialog } from "@/app/(panel)/keys/key-dialog";
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
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/** A key as this component needs it, serialised for the client boundary. */
export interface KeyRowData {
	id: string;
	name: string;
	maskedHint: string;
	createdAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
	permissions: string[];
	devices: { id: string; name: string; agentName: string }[];
}

/**
 * One API key: what it can do, where it can do it, and how to take it away.
 *
 * A key with no permissions or no printers is called out rather than left to be inferred from
 * two empty lists. Inert is the correct default for a new key, but it is also what a
 * misconfigured one looks like, and only the operator can tell which this is.
 */
export function KeyRow({ apiKey, devices }: { apiKey: KeyRowData; devices: GrantableDevice[] }) {
	const [pending, startTransition] = useTransition();
	const revoked = apiKey.revokedAt !== null;

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
		<Card className={revoked ? "opacity-60" : undefined}>
			<CardHeader className="flex flex-row flex-wrap items-center gap-3 border-b border-border pb-3">
				<div className="min-w-0 flex-1">
					<div className="truncate text-[13.5px] font-medium">{apiKey.name}</div>
					<div className="mt-0.5 font-mono text-[11.5px] text-subtle-foreground">…{apiKey.maskedHint}</div>
				</div>

				{revoked ? (
					<Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive">
						Revoked
					</Badge>
				) : (
					<Badge variant="outline" className="border-emerald-900 bg-emerald-950 text-emerald-400">
						Active
					</Badge>
				)}
			</CardHeader>

			<CardContent className="flex flex-col gap-4 pt-4">
				<div className="grid gap-3 sm:grid-cols-2">
					<Grants label="Permissions" values={apiKey.permissions} empty="None — this key cannot do anything." />
					<Grants
						label="Printers"
						values={apiKey.devices.map((device) => `${device.agentName}/${device.name}`)}
						empty="None — this key cannot address any printer."
					/>
				</div>

				<div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
					<span className="text-[11.5px] text-subtle-foreground">
						Created {new Date(apiKey.createdAt).toLocaleDateString()}
						{apiKey.lastUsedAt ? ` · last used ${new Date(apiKey.lastUsedAt).toLocaleString()}` : " · never used"}
					</span>

					<div className="flex-1" />

					{revoked ? null : (
						<>
							<KeyDialog
								devices={devices}
								keyId={apiKey.id}
								initialName={apiKey.name}
								initialPermissions={apiKey.permissions}
								initialDeviceIds={apiKey.devices.map((device) => device.id)}
								trigger={
									<Button variant="outline" size="icon" className="size-8" title="Edit grants" aria-label="Edit grants">
										<Settings2 className="size-3.5" />
									</Button>
								}
							/>

							<Confirm
								title={`Revoke ${apiKey.name}?`}
								description="The key stops working immediately and cannot be restored. Its job history is kept."
								confirmLabel="Revoke"
								disabled={pending}
								onConfirm={() => act(`${apiKey.name} revoked.`, () => revokeKey(apiKey.id))}
								trigger={
									<Button variant="outline" size="icon" className="size-8" title="Revoke" aria-label="Revoke key">
										<Ban className="size-3.5" />
									</Button>
								}
							/>
						</>
					)}

					<Confirm
						title={`Delete ${apiKey.name}?`}
						description="This removes the key and its grants. Jobs it submitted are kept but lose their attribution."
						confirmLabel="Delete"
						disabled={pending}
						onConfirm={() => act(`${apiKey.name} deleted.`, () => deleteKey(apiKey.id))}
						trigger={
							<Button
								variant="outline"
								size="icon"
								className="size-8 border-destructive/40 text-destructive hover:bg-destructive/10"
								title="Delete"
								aria-label="Delete key"
							>
								<Trash2 className="size-3.5" />
							</Button>
						}
					/>
				</div>
			</CardContent>
		</Card>
	);
}

/** One list of grants, or a plain statement that there are none. */
function Grants({ label, values, empty }: { label: string; values: string[]; empty: string }) {
	return (
		<div className="min-w-0">
			<div className="text-[11px] font-medium text-subtle-foreground">{label}</div>
			{values.length === 0 ? (
				<p className="mt-1 text-[11.5px] text-amber-400">{empty}</p>
			) : (
				<div className="mt-1.5 flex flex-wrap gap-1.5">
					{values.map((value) => (
						<Badge key={value} variant="outline" className="font-mono text-[11px]">
							{value}
						</Badge>
					))}
				</div>
			)}
		</div>
	);
}

/** A destructive action behind a confirmation. */
function Confirm({
	title,
	description,
	confirmLabel,
	disabled,
	onConfirm,
	trigger,
}: {
	title: string;
	description: string;
	confirmLabel: string;
	disabled: boolean;
	onConfirm: () => void;
	trigger: React.ReactElement;
}) {
	return (
		<AlertDialog>
			<AlertDialogTrigger disabled={disabled} render={trigger} />
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
