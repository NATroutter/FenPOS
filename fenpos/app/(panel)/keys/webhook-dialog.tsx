"use client";

import { useState, useTransition } from "react";
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
 * fresh one, for the same reason a key's own secret is shown only once — the database holds this
 * secret in plaintext (it has to, to sign with it) but shows it here exactly once, so an operator
 * who navigates away mid-copy has to register again rather than being handed it back.
 *
 * **Controlled, with no trigger of its own.** It is opened by `manage-key-dialog.tsx` stepping
 * aside for it: a URL field and a one-time secret are not something the staging model can hold, so
 * this is one of that screen's two exceptions and takes the whole dialog while it is up.
 */
export function WebhookDialog({
	apiKeyId,
	keyName,
	initialUrl,
	open,
	onOpenChange,
}: {
	apiKeyId: string;
	keyName: string;
	/** The currently registered target, or null when this key has no subscription yet. */
	initialUrl: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [url, setUrl] = useState(initialUrl ?? "");
	const [error, setError] = useState<string | null>(null);
	const [secret, setSecret] = useState<string | null>(null);
	const [saving, startSave] = useTransition();

	const save = (): void => {
		setError(null);
		startSave(async () => {
			const result = await setWebhook(apiKeyId, url.trim());
			if (result.error || !result.secret) {
				setError(result.error ?? "Could not register the webhook.");
				return;
			}
			setSecret(result.secret);
		});
	};

	// Dismissing only closes. It deliberately does not touch `secret`, which chooses between the two
	// panes below: clearing it here would swap the secret pane for the form and then play the closing
	// animation on *that*, so dismissing a freshly registered webhook flashed the form it came from
	// on the way out.
	const close = (): void => {
		onOpenChange(false);
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
				onOpenChange(next);
				// Also on the way in, because reopening within the closing animation's 100ms never reaches
				// the handler below and would otherwise reveal the last secret again.
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
