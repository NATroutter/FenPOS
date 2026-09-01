"use client";

import { Ban, RefreshCw, Trash2, Unlink, Webhook as WebhookIcon } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { deleteKey, removeWebhook, renameKey, rerollKey, revokeKey, updateKey } from "@/app/(panel)/keys/actions";
import type { GrantableDevice, KeyPermits, KeyRowData } from "@/app/(panel)/keys/key-data";
import { SecretPane } from "@/app/(panel)/keys/secret-pane";
import { WebhookDialog } from "@/app/(panel)/keys/webhook-dialog";
import { DirtyDot } from "@/components/panel/dirty-dot";
import { actionRowClass, Fact, SectionLabel, StagedAction } from "@/components/panel/manage-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { PERMISSIONS } from "@/lib/domain/permissions";
import { formatDate, formatDateTime } from "@/lib/format/datetime";

/** Whether two lists hold the same ids, order aside. */
function sameSet(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((entry) => right.includes(entry));
}

/**
 * Everything about one API key, on one screen, committed by one button.
 *
 * **This replaces a row of six unlabelled icon buttons and the dialogs behind them.** Edit grants,
 * reroll, revoke, register a webhook, remove one, delete — each was its own glyph with its own
 * confirmation, and the two destructive ones were told apart from the rest by being red. The account
 * dialog's habits apply here for the same reasons they applied there: staged edits, dirty dots, a
 * footer that counts what is outstanding, and one Save.
 *
 * Two columns, like the account dialog and unlike the role one, because a key is genuinely two
 * unrelated things at once: what it *is* (its name, when it was minted, when it was last used) and
 * what it may *do* (its permissions, its printers, where its notifications go).
 *
 * **Nothing here fires when it is clicked**, with two exceptions that the staging model cannot
 * honestly represent. **The webhook** needs a URL and hands back a signing secret shown exactly
 * once, so it is a form rather than a switch. **Delete** ends the thing being edited, so there is
 * nothing left for Save to apply the rest of the form to; it keeps its confirmation.
 *
 * **Reroll is staged, and that is not a contradiction.** It also hands back a one-time secret, but
 * it takes no input, so arming it is a tick like any other — Save runs it last and the secret pane
 * opens on the way out, in place of the dialog rather than on top of it.
 */
export function ManageKeyDialog({
	apiKey,
	devices,
	permits,
	trigger,
}: {
	apiKey: KeyRowData;
	devices: GrantableDevice[];
	permits: KeyPermits;
	trigger: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	const [webhookOpen, setWebhookOpen] = useState(false);

	const [name, setName] = useState(apiKey.name);
	const [permissions, setPermissions] = useState<string[]>(apiKey.permissions);
	const [deviceIds, setDeviceIds] = useState<string[]>(apiKey.devices.map((device) => device.id));
	const [reroll, setReroll] = useState(false);
	const [revoke, setRevoke] = useState(false);
	const [dropWebhook, setDropWebhook] = useState(false);

	const [error, setError] = useState<string | null>(null);
	const [saving, startSave] = useTransition();

	/**
	 * The secret a staged reroll produced, and whether its pane is up.
	 *
	 * Two pieces of state rather than one derived from the other: derived, dismissing cleared both at
	 * once and the pane emptied while it was still fading out.
	 */
	const [rerolled, setRerolled] = useState<string | null>(null);
	const [showSecret, setShowSecret] = useState(false);

	const revoked = apiKey.revokedAt !== null;

	const reset = (): void => {
		setName(apiKey.name);
		setPermissions(apiKey.permissions);
		setDeviceIds(apiKey.devices.map((device) => device.id));
		setReroll(false);
		setRevoke(false);
		setDropWebhook(false);
		setError(null);
	};

	/** Set while the webhook dialog has taken this one's place — see the account dialog's own note. */
	const returningFromWebhook = useRef(false);

	useEffect(() => {
		if (!open) {
			return;
		}
		if (returningFromWebhook.current) {
			returningFromWebhook.current = false;
			return;
		}
		// Keyed on the key and the open flag alone: `reset` is recreated every render, so depending on
		// it would re-run this on every keystroke and make the form impossible to type in.
		reset();
	}, [open, apiKey]);

	const nameDirty = name !== apiKey.name;
	const permissionsDirty = !sameSet(permissions, apiKey.permissions);
	const devicesDirty = !sameSet(
		deviceIds,
		apiKey.devices.map((device) => device.id),
	);

	const dirtyCount =
		Number(nameDirty) +
		Number(permissionsDirty || devicesDirty) +
		Number(reroll) +
		Number(revoke) +
		Number(dropWebhook);

	const toggle = (list: string[], value: string): string[] =>
		list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

	const showDanger = (permits.reroll && !revoked) || (permits.revoke && !revoked) || permits.remove;

	/**
	 * Applies everything staged, in the order that leaves the key in the intended state.
	 *
	 * Name and grants first, because a refusal there should not follow a secret that has already been
	 * replaced. Revoking last of the changes, because a revoked key is one the other actions have
	 * nothing left to say about — and the reroll before it, so a key that is being reissued *and*
	 * revoked ends up revoked rather than holding a secret nobody will ever use.
	 *
	 * Every step names the permit its control is rendered under, the same way the account dialog's
	 * does. Not a security check — `panel-action.ts` refuses each of these again and writes a `DENIED`
	 * row, and that is the boundary — but so that what is offered and what is sent cannot drift.
	 */
	const save = (): void => {
		setError(null);
		startSave(async () => {
			if (permits.rename && nameDirty) {
				const result = await renameKey(apiKey.id, name.trim());
				if (result.error) {
					setError(result.error);
					return;
				}
			}

			if (permits.update && (permissionsDirty || devicesDirty)) {
				const result = await updateKey(apiKey.id, permissions, deviceIds);
				if (result.error) {
					setError(result.error);
					return;
				}
			}

			if (permits.removeWebhook && dropWebhook) {
				const result = await removeWebhook(apiKey.id);
				if (result.error) {
					setError(result.error);
					return;
				}
			}

			// Held rather than shown straight away: revoking may still refuse below, and a secret pane
			// over a form that then reports an error is two answers at once.
			let secret: string | null = null;
			if (permits.reroll && reroll) {
				const result = await rerollKey(apiKey.id);
				if (result.error || !result.secret) {
					setError(result.error ?? "Could not reissue the key.");
					return;
				}
				secret = result.secret;
			}

			if (permits.revoke && revoke) {
				const result = await revokeKey(apiKey.id);
				if (result.error) {
					setError(result.error);
					return;
				}
			}

			toast.success(`${apiKey.name} updated.`);
			setOpen(false);
			// In place of this dialog rather than on top of it, and only once it has gone: this is the
			// only moment the new secret exists anywhere outside a clipboard.
			if (secret !== null) {
				setRerolled(secret);
				setShowSecret(true);
			}
		});
	};

	return (
		<>
			{/*
			 * A sibling of the dialog below, never a child, and the two are never open together — the
			 * pattern the account dialog's permission list uses, for the same reason: anything nested in
			 * the content unmounts the moment this dialog closes, and the staging held here would go
			 * with it.
			 */}
			<WebhookDialog
				apiKeyId={apiKey.id}
				keyName={apiKey.name}
				initialUrl={apiKey.webhook?.url ?? null}
				open={webhookOpen}
				onOpenChange={(nextOpen) => {
					setWebhookOpen(nextOpen);
					if (!nextOpen) {
						setOpen(true);
					}
				}}
			/>

			{/*
			 * The pane carrying a rerolled secret. Opened by Save succeeding rather than by a trigger,
			 * and dismissed only on purpose.
			 */}
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

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogTrigger render={trigger} />
				<DialogContent className="max-h-[88vh] sm:max-w-[720px]">
					<DialogHeader className="pr-11">
						<DialogTitle className="flex min-w-0 items-center gap-2">
							<span className="truncate">{apiKey.name}</span>
							{revoked ? (
								<Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive">
									Revoked
								</Badge>
							) : (
								<Badge variant="outline" className="border-emerald-900 bg-emerald-950 text-emerald-400">
									Active
								</Badge>
							)}
						</DialogTitle>
						<div className="truncate font-mono text-[11.5px] text-subtle-foreground">…{apiKey.maskedHint}</div>
					</DialogHeader>

					<DialogBody className="gap-6">
						<div className="grid gap-6 md:grid-cols-2">
							<div className="flex min-w-0 flex-col gap-4">
								<SectionLabel>Key</SectionLabel>

								<Field>
									<FieldLabel htmlFor={`key-name-${apiKey.id}`} className="gap-1.5">
										Name
										{nameDirty ? <DirtyDot /> : null}
									</FieldLabel>
									<Input
										id={`key-name-${apiKey.id}`}
										value={name}
										disabled={saving || !permits.rename || revoked}
										placeholder="Till software"
										onChange={(event) => setName(event.target.value)}
									/>
								</Field>

								{/*
								 * The facts, not the fields. Read-only on purpose: none of these is something an
								 * operator sets — they are what the key has done or had done to it, which is the
								 * half of "what is this key" no input on this screen can answer.
								 */}
								<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-border pt-3 text-[12px]">
									<Fact label="Status">
										{revoked ? (
											<span className="text-destructive">Revoked {formatDate(apiKey.revokedAt as string)}</span>
										) : (
											"Active"
										)}
									</Fact>
									<Fact label="Created">{formatDateTime(apiKey.createdAt)}</Fact>
									<Fact label="Minted by">{apiKey.createdByName ?? "—"}</Fact>
									<Fact label="Last used">
										{apiKey.lastUsedAt === null ? "Never" : formatDateTime(apiKey.lastUsedAt)}
									</Fact>
									<Fact label="Webhook">{apiKey.webhook ? apiKey.webhook.url : "None"}</Fact>
									<Fact label="Id">
										<span className="font-mono">{apiKey.id}</span>
									</Fact>
								</dl>

								{/*
								 * Beside the facts rather than in the Danger zone: pointing a key's notifications
								 * somewhere is a change to what it does, not a way to take it away. Removing one
								 * is the same decision reversed, which is why it sits here too rather than beside
								 * Revoke.
								 */}
								{permits.setWebhook || (permits.removeWebhook && apiKey.webhook) ? (
									<div className="flex flex-col gap-2">
										<SectionLabel>Notifications</SectionLabel>
										{permits.setWebhook ? (
											<button
												type="button"
												disabled={saving}
												className={actionRowClass({ destructive: false, staged: false })}
												onClick={() => {
													returningFromWebhook.current = true;
													setWebhookOpen(true);
													setOpen(false);
												}}
											>
												<span className="flex w-full items-center gap-2 text-[12.5px]">
													<span className="shrink-0 text-subtle-foreground">
														<WebhookIcon className="size-3.5" />
													</span>
													<span className="min-w-0 flex-1 truncate">
														{apiKey.webhook ? "Rotate webhook" : "Register webhook"}
													</span>
													<span className="shrink-0 text-[10.5px] tracking-[0.06em] text-subtle-foreground uppercase">
														{apiKey.webhook ? "registered" : "none"}
													</span>
												</span>
												<span className="text-[11px] text-subtle-foreground">
													Saving always issues a new signing secret, shown once.
												</span>
											</button>
										) : null}

										{/* Offered even for a revoked key, unlike every other action here: revoking stops
										    outbound delivery on its own, but the subscription row survives it, and an
										    operator investigating a leak needs a way to clear it without deleting the key
										    and the job history hanging off it. */}
										{permits.removeWebhook && apiKey.webhook ? (
											<StagedAction
												destructive
												icon={<Unlink className="size-3.5" />}
												label="Remove webhook"
												hint="Deliveries stop and anything still queued is discarded with it."
												staged={dropWebhook}
												disabled={saving}
												onToggle={() => setDropWebhook((current) => !current)}
											/>
										) : null}
									</div>
								) : null}
							</div>

							<div className="flex min-w-0 flex-col gap-4">
								<div className="flex flex-col gap-2.5">
									<span className="flex items-center gap-1.5">
										<SectionLabel>Permissions</SectionLabel>
										{permissionsDirty ? <DirtyDot /> : null}
									</span>
									{/* Four of them, so they are checkboxes rather than a dialog behind a button. The
									    account screen puts its list behind one because that list is fifty rows; this one
									    fits beside the printers it has to be read with. */}
									{PERMISSIONS.map((permission) => (
										<div key={permission.id} className="flex items-start gap-2.5">
											<Checkbox
												id={`key-permission-${apiKey.id}-${permission.id}`}
												className="mt-0.5"
												checked={permissions.includes(permission.id)}
												disabled={saving || !permits.update || revoked}
												onCheckedChange={() => setPermissions((current) => toggle(current, permission.id))}
											/>
											{/* Stacked rather than laid out in a row: every id begins at the same x, and a
											    description that wraps does so under itself rather than pushing its id off
											    the checkbox it belongs to. */}
											<FieldLabel
												htmlFor={`key-permission-${apiKey.id}-${permission.id}`}
												className="w-full cursor-pointer flex-col items-start gap-0.5 font-normal"
											>
												<span className="font-mono text-[12px]">{permission.id}</span>
												<span className="text-[11.5px] font-normal text-subtle-foreground">
													{permission.description}
												</span>
											</FieldLabel>
										</div>
									))}
								</div>

								<div className="flex flex-col gap-2.5 border-t border-border pt-3">
									<span className="flex items-center gap-1.5">
										<SectionLabel>Printers</SectionLabel>
										{devicesDirty ? <DirtyDot /> : null}
									</span>
									{devices.length === 0 ? (
										<p className="text-[11.5px] text-subtle-foreground">
											No printers configured yet. Add one on the Devices tab first.
										</p>
									) : (
										devices.map((device) => (
											<div key={device.id} className="flex items-center gap-2.5">
												<Checkbox
													id={`key-device-${apiKey.id}-${device.id}`}
													checked={deviceIds.includes(device.id)}
													disabled={saving || !permits.update || revoked}
													onCheckedChange={() => setDeviceIds((current) => toggle(current, device.id))}
												/>
												<FieldLabel
													htmlFor={`key-device-${apiKey.id}-${device.id}`}
													className="cursor-pointer font-normal"
												>
													<span className="font-mono text-[12px]">
														{device.agentName}/{device.name}
													</span>
												</FieldLabel>
											</div>
										))
									)}
								</div>

								{/* A key needs both before it can do anything, so an empty list on either side is
								    said out loud rather than left to be inferred from two things that are not there. */}
								{!revoked && (permissions.length === 0 || deviceIds.length === 0) ? (
									<p className="text-[11.5px] text-amber-400">
										{permissions.length === 0 && deviceIds.length === 0
											? "This key can do nothing: it has neither a permission nor a printer."
											: permissions.length === 0
												? "This key can do nothing: it has no permission."
												: "This key can reach no printer."}
									</p>
								) : null}

								{showDanger ? (
									<div className="flex flex-col gap-2 border-t border-border pt-3">
										<SectionLabel destructive>Danger zone</SectionLabel>

										{permits.reroll && !revoked ? (
											<StagedAction
												destructive
												icon={<RefreshCw className="size-3.5" />}
												label="Reroll the secret"
												hint="A new secret is issued and shown once. Anything still using the old one is refused."
												staged={reroll}
												disabled={saving}
												onToggle={() => setReroll((current) => !current)}
											/>
										) : null}

										{permits.revoke && !revoked ? (
											<StagedAction
												destructive
												icon={<Ban className="size-3.5" />}
												label="Revoke the key"
												hint="It stops working and cannot be restored. Its job history is kept."
												staged={revoke}
												disabled={saving}
												onToggle={() => setRevoke((current) => !current)}
											/>
										) : null}

										{/* Not staged, for the reason it is not on the account screen: it destroys the
										    thing being edited, so there is nothing left for Save to apply the rest to. */}
										{permits.remove ? (
											<DeleteAction
												keyId={apiKey.id}
												keyName={apiKey.name}
												disabled={saving}
												onDeleted={() => setOpen(false)}
											/>
										) : null}
									</div>
								) : null}
							</div>
						</div>

						{error ? (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
					</DialogBody>

					<DialogFooter>
						{dirtyCount > 0 ? (
							<span className="mr-auto text-[12.5px] text-muted-foreground">
								{dirtyCount === 1 ? "1 unsaved change" : `${dirtyCount} unsaved changes`}
							</span>
						) : (
							<span className="mr-auto" />
						)}
						<Button type="button" variant="ghost" disabled={saving || dirtyCount === 0} onClick={reset}>
							Discard
						</Button>
						<Button type="button" disabled={saving || dirtyCount === 0 || name.trim() === ""} onClick={save}>
							{saving ? <Spinner className="size-3.5" /> : null}
							Save changes
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

/**
 * Deleting, which keeps its confirmation.
 *
 * The one action here that cannot be staged: it destroys the thing being edited, so there is no key
 * left for Save changes to apply the rest of the form to.
 */
function DeleteAction({
	keyId,
	keyName,
	disabled,
	onDeleted,
}: {
	keyId: string;
	keyName: string;
	disabled: boolean;
	onDeleted: () => void;
}) {
	const [pending, startTransition] = useTransition();

	return (
		<AlertDialog>
			<AlertDialogTrigger
				disabled={disabled || pending}
				render={<button type="button" className={actionRowClass({ destructive: true, staged: false })} />}
			>
				{/* The same inner row `StagedAction` draws, so this trigger and the staged rows above it
				    are the same object to look at. */}
				<span className="flex w-full items-center gap-2 text-[12.5px]">
					<span className="shrink-0 text-destructive/70">
						<Trash2 className="size-3.5" />
					</span>
					<span className="min-w-0 flex-1 truncate">Delete the key</span>
				</span>
				<span className="text-[11px] text-destructive/70">Jobs it submitted are kept but lose their attribution.</span>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete {keyName}?</AlertDialogTitle>
					<AlertDialogDescription>
						This removes the key and its grants. Jobs it submitted are kept but lose their attribution. Revoking instead
						keeps the record and the attribution with it.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={() =>
							startTransition(async () => {
								const result = await deleteKey(keyId);
								if (result.error) {
									toast.error(result.error);
									return;
								}
								toast.success(`${keyName} deleted.`);
								onDeleted();
							})
						}
					>
						Delete
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
