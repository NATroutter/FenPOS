"use client";

import { type ReactElement, useState, useTransition } from "react";
import { setWebhook } from "@/app/(panel)/keys/actions";
import { SecretPane } from "@/app/(panel)/keys/secret-pane";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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

/**
 * Registers or rotates a key's webhook target, and shows its new secret exactly once.
 *
 * **This lives on the Keys tab rather than behind the public API on purpose.** A key that could
 * aim its own webhook anywhere could redirect another integrator's notifications if it leaked, so
 * choosing where a key's deliveries go is an admin-session decision, never something a key does to
 * itself — the same reasoning that keeps every action in `actions.ts` behind `requireSession`.
 *
 * There is deliberately no "keep the old secret, just change the URL" path: saving always issues a
 * fresh one, for the same reason `key-dialog.tsx`'s creation flow shows a key's secret only once —
 * the database holds this secret in plaintext (it has to, to sign with it) but shows it here
 * exactly once, so an operator who navigates away mid-copy has to register again rather than being
 * handed it back.
 */
export function WebhookDialog({
	apiKeyId,
	keyName,
	initialUrl,
	trigger,
}: {
	apiKeyId: string;
	keyName: string;
	/** The currently registered target, or null when this key has no subscription yet. */
	initialUrl: string | null;
	trigger: ReactElement;
}) {
	const [open, setOpen] = useState(false);
	const [url, setUrl] = useState(initialUrl ?? "");
	const [error, setError] = useState<string | null>(null);
	const [secret, setSecret] = useState<string | null>(null);
	const [saving, startSave] = useTransition();

	const save = (): void => {
		setError(null);
		startSave(async () => {
			try {
				const result = await setWebhook(apiKeyId, url.trim());
				setSecret(result.secret);
			} catch (caught) {
				setError(caught instanceof Error ? caught.message : "Could not register the webhook.");
			}
		});
	};

	// Dismissing only closes — see key-dialog.tsx's `close` for why `secret` is left alone rather
	// than cleared here.
	const close = (): void => {
		setOpen(false);
	};

	/** Returns the dialog to its opening state. Safe to call more than once. */
	const reset = (): void => {
		setError(null);
		setSecret(null);
		setUrl(initialUrl ?? "");
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				// Also on the way in — see key-dialog.tsx's identical guard for why.
				if (next) {
					reset();
				}
			}}
			onOpenChangeComplete={(nowOpen) => {
				if (!nowOpen) {
					reset();
				}
			}}
		>
			<DialogTrigger render={trigger} />
			<DialogContent className="sm:max-w-[520px]">
				{secret ? (
					<>
						<DialogHeader>
							<DialogTitle>Copy this secret now</DialogTitle>
							<DialogDescription>
								{keyName}'s webhook is registered. It signs every delivery and is stored in plaintext — this server has
								to hold it to sign with — but it is shown here only once. If you lose it, register the target again to
								issue a new one.
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
							<DialogTitle>{initialUrl ? "Rotate webhook" : "Register webhook"}</DialogTitle>
							<DialogDescription>
								{keyName} will receive a signed POST for every job it submits that settles. Saving always issues a new
								secret, even if only the URL changes.
							</DialogDescription>
						</DialogHeader>
						<DialogBody>
							<div className="flex flex-col gap-4">
								<Field>
									<FieldLabel htmlFor="webhook-url">Target URL</FieldLabel>
									<Input
										id="webhook-url"
										value={url}
										disabled={saving}
										placeholder="https://example.com/hooks/fenpos"
										onChange={(event) => setUrl(event.target.value)}
									/>
									<FieldDescription>
										Checked before it is saved: it must resolve to an address on the public internet, and to https
										unless this install allows plain http.
									</FieldDescription>
								</Field>

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
							<Button type="button" disabled={saving || url.trim() === ""} onClick={save}>
								{saving ? <Spinner className="size-3.5" /> : null}
								{initialUrl ? "Rotate" : "Register"}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
