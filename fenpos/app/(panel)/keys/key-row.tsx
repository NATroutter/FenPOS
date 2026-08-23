"use client";

import { Ban, KeyRound, RefreshCw, Settings2, Trash2, Unlink, Webhook as WebhookIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { deleteKey, removeWebhook, rerollKey, revokeKey } from "@/app/(panel)/keys/actions";
import { type GrantableDevice, KeyDialog } from "@/app/(panel)/keys/key-dialog";
import { SecretPane } from "@/app/(panel)/keys/secret-pane";
import { WebhookDialog } from "@/app/(panel)/keys/webhook-dialog";
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
import { Card, CardActions, CardContent, CardHeader } from "@/components/ui/card";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { formatDate, formatDateTime } from "@/lib/format/datetime";

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
	/** This key's webhook subscription, or null when it has none. */
	webhook: { url: string } | null;
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
	const [rerolled, setRerolled] = useState<string | null>(null);
	// Tracked apart from the secret rather than derived from it. Derived, dismissing cleared both
	// at once and the body emptied while the dialog was still fading out.
	const [showSecret, setShowSecret] = useState(false);
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

	// No success toast: the dialog carrying the new secret is the confirmation, and a toast over
	// it would be one more thing to dismiss while copying something that cannot be recovered.
	const reroll = (): void => {
		startTransition(async () => {
			const result = await rerollKey(apiKey.id);
			if (result.error || !result.secret) {
				toast.error(result.error ?? "Could not reissue the key.");
				return;
			}
			setRerolled(result.secret);
			setShowSecret(true);
		});
	};

	return (
		<Card className={revoked ? "opacity-60" : undefined}>
			<CardHeader className="flex flex-row flex-wrap items-center gap-3 border-b border-border pb-3">
				<KeyRound className="size-4.5 shrink-0 text-subtle-foreground" />
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
				<CardActions>
					<span className="text-[11.5px] text-subtle-foreground">
						Created {formatDate(apiKey.createdAt)}
						{apiKey.lastUsedAt ? ` · last used ${formatDateTime(apiKey.lastUsedAt)}` : " · never used"}
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
								title={`Reroll ${apiKey.name}?`}
								description="A new secret is issued and shown once. The current one stops working immediately, so anything still using it is refused until it is updated. The name, grants and job history are kept."
								confirmLabel="Reroll"
								disabled={pending}
								onConfirm={reroll}
								trigger={
									<Button variant="outline" size="icon" className="size-8" title="Reroll" aria-label="Reroll key">
										<RefreshCw className="size-3.5" />
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

							<WebhookDialog
								apiKeyId={apiKey.id}
								keyName={apiKey.name}
								initialUrl={apiKey.webhook?.url ?? null}
								trigger={
									<Button
										variant="outline"
										size="icon"
										className="size-8"
										title={apiKey.webhook ? "Rotate webhook" : "Register webhook"}
										aria-label={apiKey.webhook ? "Rotate webhook" : "Register webhook"}
									>
										<WebhookIcon className="size-3.5" />
									</Button>
								}
							/>

							{apiKey.webhook ? (
								<Confirm
									title={`Remove ${apiKey.name}'s webhook?`}
									description="Deliveries stop and anything still queued for it is discarded along with it. Registering again issues a new secret."
									confirmLabel="Remove"
									disabled={pending}
									onConfirm={() => act("Webhook removed.", () => removeWebhookResult(apiKey.id))}
									trigger={
										<Button
											variant="outline"
											size="icon"
											className="size-8 border-destructive/40 text-destructive hover:bg-destructive/10"
											title="Remove webhook"
											aria-label="Remove webhook"
										>
											<Unlink className="size-3.5" />
										</Button>
									}
								/>
							) : null}
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
				</CardActions>
			</CardContent>

			{/* Opened by the reroll succeeding rather than by a trigger, and dismissed only on purpose:
			    this is the only moment the new secret exists anywhere outside a clipboard. */}
			<Dialog
				open={showSecret}
				onOpenChange={setShowSecret}
				// The secret is dropped once the closing animation has finished, so the pane fades out
				// still showing what it was dismissed on rather than emptying first.
				onOpenChangeComplete={(nowOpen) => {
					if (!nowOpen) {
						setRerolled(null);
					}
				}}
			>
				<DialogContent className="sm:max-w-[560px]">
					<DialogHeader>
						<DialogTitle>Copy this key now</DialogTitle>
						<DialogDescription>
							{apiKey.name} has a new secret and the old one no longer works. It is stored as a hash and cannot be shown
							again — if you lose it, reroll again.
						</DialogDescription>
					</DialogHeader>
					<DialogBody>{rerolled ? <SecretPane secret={rerolled} /> : null}</DialogBody>
					<DialogFooter>
						<Button type="button" onClick={() => setShowSecret(false)}>
							Done
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Card>
	);
}

/**
 * Adapts {@link removeWebhook} to the `{ error }` shape {@link KeyRow}'s `act` helper expects.
 *
 * `removeWebhook` throws rather than returning an error — see its own doc comment — because
 * `setWebhook`'s sibling test asserts the rejection directly. `act` is shared with every other
 * button on this row, all of which return `{ error }`, so this is the one place that difference is
 * absorbed rather than spreading a second error-handling shape across the component.
 *
 * @param apiKeyId the key whose subscription is removed
 * @returns the state {@link act} expects
 */
async function removeWebhookResult(apiKeyId: string): Promise<{ error: string | null }> {
	try {
		await removeWebhook(apiKeyId);
		return { error: null };
	} catch (error) {
		return { error: error instanceof Error ? error.message : "Could not remove the webhook." };
	}
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
