"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * A code sample with a copy button.
 *
 * The whole reason this page exists is that someone is about to run one of these. Reading a
 * curl invocation off a screen and retyping it is how a header ends up misspelled, so the
 * sample is copyable rather than merely legible.
 *
 * A client component only for the clipboard; the samples themselves are rendered on the server
 * with this install's own address and printer names in them.
 */
export function CodeBlock({ children, label }: { children: string; label?: string }) {
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) {
			return;
		}
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);

	return (
		<div className="group/code relative overflow-hidden rounded-lg border border-border bg-[#0f0f0f]">
			{label ? (
				<div className="flex items-center justify-between border-b border-border/70 bg-muted/30 px-3 py-1.5">
					<span className="font-mono text-[10.5px] tracking-[0.08em] text-subtle-foreground uppercase">{label}</span>
				</div>
			) : null}

			<pre className="overflow-x-auto p-3 pr-11 font-mono text-[11.5px] leading-relaxed text-foreground/90">
				{children}
			</pre>

			<button
				type="button"
				title="Copy"
				aria-label="Copy code sample"
				// Always present rather than revealed on hover: a control that only exists once the
				// pointer is on it is a control most people never find.
				className="absolute top-2 right-2 inline-flex size-7 items-center justify-center rounded-md border border-border bg-card text-subtle-foreground transition-colors hover:border-input hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
				onClick={async () => {
					try {
						await navigator.clipboard.writeText(children);
						setCopied(true);
					} catch {
						// Clipboard access is refused over plain HTTP in some browsers. Saying so beats a
						// button that silently does nothing.
						toast.error("Could not copy. Select the text and copy it manually.");
					}
				}}
			>
				{copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
			</button>
		</div>
	);
}
