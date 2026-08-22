"use client";

import { Check, Copy, RefreshCw } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { refreshPairingCode } from "@/app/(panel)/agents/actions";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * What an operator needs in order to pair a agent: the address, the code, and how long the
 * code has left.
 *
 * Both values are shown in full and are copyable. They are read off this screen and typed
 * into a terminal in another room, which is why the code is large, monospace, and drawn from
 * an alphabet with no ambiguous characters.
 *
 * `pairingEnabled` arrives as a plain boolean prop rather than being read here: `settings-service.ts`
 * is `server-only` and this is a Client Component, so the value has to be resolved on the server
 * (`AgentsPage`) and threaded down through `AgentCard` — reading the setting directly from this
 * module would fail to build, and a module-level cache of it would not be visible to this component
 * regardless, since Next bundles Client Components into a separate module layer from the one that
 * cache would live in.
 *
 * When pairing is switched off, redeeming the code shown here would always be refused — the
 * endpoint cannot tell a stale code from a disabled one — so this shows a plain notice instead of
 * a code nobody could use.
 */
export function PairingPanel({
	agentId,
	agentName,
	code,
	expiresAt,
	serverAddress,
	addressIsInferred,
	pairingEnabled,
}: {
	agentId: string;
	agentName: string;
	code: string;
	expiresAt: string;
	serverAddress: string;
	/** Whether the address was derived from this request rather than configured. */
	addressIsInferred: boolean;
	/** Whether `/api/pair` currently accepts codes at all. */
	pairingEnabled: boolean;
}) {
	const [pending, startTransition] = useTransition();

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-1.5">
				<span className="text-[11px] font-medium text-subtle-foreground">Server address</span>
				<CopyableValue value={serverAddress} label="Server address" />
				{addressIsInferred ? (
					<p className="text-[11px] leading-relaxed text-subtle-foreground">
						Inferred from this request. If agents reach the server on a different address, set it under{" "}
						<span className="font-medium">Settings → General</span>.
					</p>
				) : null}
			</div>

			{pairingEnabled ? (
				<>
					<div className="flex flex-col gap-1.5">
						<span className="text-[11px] font-medium text-subtle-foreground">Pairing code</span>
						<CopyableValue value={code} label="Pairing code" large />
						<Countdown expiresAt={expiresAt} />
					</div>

					<div className="rounded-md border border-border bg-background p-3">
						<p className="text-[11px] font-medium text-subtle-foreground">Run on the agent</p>
						<code className="mt-1.5 block overflow-x-auto font-mono text-xs whitespace-nowrap text-foreground">
							pair {serverAddress} {code}
						</code>
					</div>

					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={pending}
						onClick={() =>
							startTransition(async () => {
								const result = await refreshPairingCode(agentId);
								if (result.error) {
									toast.error(result.error);
								} else {
									toast.success(`New pairing code issued for ${agentName}.`);
								}
							})
						}
					>
						{pending ? <Spinner /> : <RefreshCw className="size-3.5" />}
						New code
					</Button>
				</>
			) : (
				<p className="text-[11px] leading-relaxed text-subtle-foreground">
					Pairing is switched off, so this code cannot be redeemed. Turn it back on under{" "}
					<span className="font-medium">Settings → Security</span>.
				</p>
			)}
		</div>
	);
}

/**
 * A value shown in monospace with a copy button.
 *
 * Copy feedback is inline rather than a toast: the operator is looking at the value they
 * just clicked, so confirmation belongs there.
 */
function CopyableValue({ value, label, large = false }: { value: string; label: string; large?: boolean }) {
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) {
			return;
		}
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);

	return (
		<div className="flex items-center gap-2">
			<code
				className={`min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono whitespace-nowrap ${
					large ? "text-lg tracking-[0.12em]" : "text-xs"
				}`}
			>
				{value}
			</code>
			<Button
				type="button"
				variant="outline"
				size="icon"
				className="size-8 shrink-0"
				aria-label={`Copy ${label.toLowerCase()}`}
				title={`Copy ${label.toLowerCase()}`}
				onClick={async () => {
					try {
						await navigator.clipboard.writeText(value);
						setCopied(true);
					} catch {
						// Clipboard access is refused in some browsers over plain HTTP. Saying so
						// beats a button that silently does nothing.
						toast.error("Could not copy. Select the text and copy it manually.");
					}
				}}
			>
				{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
			</Button>
		</div>
	);
}

/**
 * Time remaining before a pairing code lapses.
 *
 * Counted on the client from a server-supplied instant, because a duration rendered on the
 * server is stale on arrival. Renders nothing until mounted, which also avoids a hydration
 * mismatch on a value that changes every second.
 */
function Countdown({ expiresAt }: { expiresAt: string }) {
	const [remaining, setRemaining] = useState<number | null>(null);

	useEffect(() => {
		const target = new Date(expiresAt).getTime();
		const update = () => setRemaining(target - Date.now());
		update();

		const timer = setInterval(update, 1000);
		return () => clearInterval(timer);
	}, [expiresAt]);

	if (remaining === null) {
		return <span className="text-[11px] text-subtle-foreground">&nbsp;</span>;
	}

	if (remaining <= 0) {
		return <span className="text-[11px] font-medium text-destructive">Expired. Issue a new code.</span>;
	}

	const totalSeconds = Math.floor(remaining / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;

	return (
		<span className="font-mono text-[11px] text-subtle-foreground tabular-nums">
			Expires in {minutes}:{String(seconds).padStart(2, "0")}
		</span>
	);
}
