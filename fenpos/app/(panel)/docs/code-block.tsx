"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

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

	/**
	 * The copy control, placed differently depending on whether there is a label bar to put it in.
	 *
	 * Always present rather than revealed on hover: a control that only exists once the pointer is
	 * on it is a control most people never find.
	 */
	const copy = (
		<button
			type="button"
			title="Copy"
			aria-label="Copy code sample"
			className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-card text-subtle-foreground transition-colors hover:border-input hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
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
	);

	return (
		<div className="group/code relative overflow-hidden rounded-lg border border-border bg-[#0f0f0f]">
			{/* In the label row rather than floated over it. Absolutely positioned at `top-2`, a 28px
			    button hung nearly 6px below a 30px strip and read as having escaped it — and the row
			    was already a `justify-between` with one child, which is a row asking for the second. */}
			{label ? (
				<div className="flex items-center justify-between gap-3 border-b border-border/70 bg-muted/30 py-1 pr-1.5 pl-3">
					<span className="truncate font-mono text-[10.5px] tracking-[0.08em] text-subtle-foreground uppercase">
						{label}
					</span>
					{copy}
				</div>
			) : (
				<div className="absolute top-2 right-2 z-10">{copy}</div>
			)}

			{/* `pr-11` only where the button floats over the code. Under a label bar the button is out
			    of the text's way, and the reserved gutter would just be a ragged right margin. */}
			<pre
				className={cn(
					"overflow-x-auto p-3 font-mono text-[11.5px] leading-relaxed text-foreground/90",
					label ? null : "pr-11",
				)}
			>
				{children}
			</pre>
		</div>
	);
}
