"use client";

import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/**
 * Fired by the contents rail, carrying the id of the section its link points at.
 *
 * The hash on its own is not enough to drive this. `hashchange` does not fire when a link sets the
 * hash to what it already is, so clicking a rail entry, collapsing that section, then clicking the
 * same entry again would leave it shut — which is exactly the sequence someone follows after
 * closing a section by mistake.
 */
export const DOC_REVEAL_EVENT = "fenpos:docs-reveal";

/** An HTTP method, coloured by what it does to the world. */
export type Verb = "POST" | "GET" | "DELETE";

/**
 * Method chips, in the panel's existing state palette.
 *
 * Deliberately not a new set of colours: emerald already means "it worked", sky "in flight" and
 * destructive "it failed" on the Jobs tab. Reusing them means a reader who has looked at one
 * screen already knows what the hues mean on this one.
 */
const VERB_STYLE: Record<Verb, string> = {
	POST: "border-emerald-900 bg-emerald-950 text-emerald-400",
	GET: "border-sky-900 bg-sky-950 text-sky-400",
	DELETE: "border-destructive/40 bg-destructive/10 text-destructive",
};

/** The rule down the left of a section, tinted by its primary method. */
const RULE_STYLE: Record<Verb | "none", string> = {
	POST: "bg-emerald-500/50",
	GET: "bg-sky-500/50",
	DELETE: "bg-destructive/50",
	none: "bg-border",
};

/**
 * One collapsible section of the reference.
 *
 * Open by default. The docs are read by someone who has a request failing right now, and a page
 * of closed headings makes them click through every one to find which section mentions their
 * error code — the browser's own find already does that job if the text is on the page.
 *
 * The header states the endpoint rather than describing it. An operator scanning for where to
 * send a receipt is looking for `POST /api/print/…`, not for a sentence about paths, so the
 * method and the path are the heading's second line and everything prose-shaped waits inside.
 */
export function DocSection({
	id,
	title,
	verbs,
	path,
	note,
	children,
}: {
	/** Anchor target, so the contents rail can jump here. */
	id: string;
	title: string;
	/** The methods this section documents, if it documents an endpoint. */
	verbs?: readonly Verb[];
	/** The path those methods take, shown in monospace beside them. */
	path?: string;
	/** What the section covers, for sections that are not about one endpoint. */
	note?: string;
	children: ReactNode;
}) {
	const rule = RULE_STYLE[verbs?.[0] ?? "none"];
	const [open, setOpen] = useState(true);

	// Being linked to opens the section. Jumping to a heading that stays shut lands the reader on
	// the one thing they asked not to be given — the title they already read in the rail.
	useEffect(() => {
		const revealIfTargeted = (event?: Event): void => {
			const targeted = event instanceof CustomEvent ? event.detail === id : window.location.hash.slice(1) === id;
			if (!targeted) {
				return;
			}
			setOpen(true);
			// The browser has already jumped, against a page whose sections were still shut. With
			// several of them closed the page is short enough that it runs out of scroll before the
			// heading reaches the top, and expanding afterwards only pushes it further down. Repeating
			// the jump once the section has grown lands it where the anchor promised.
			requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
		};

		// Once on mount, for a deep link followed from outside the page or a reload on the anchor.
		revealIfTargeted();
		window.addEventListener("hashchange", revealIfTargeted);
		window.addEventListener(DOC_REVEAL_EVENT, revealIfTargeted);
		return () => {
			window.removeEventListener("hashchange", revealIfTargeted);
			window.removeEventListener(DOC_REVEAL_EVENT, revealIfTargeted);
		};
	}, [id]);

	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			id={id}
			// Offset so a jump does not tuck the heading under the sticky page header.
			className="relative scroll-mt-6 overflow-hidden rounded-lg border border-border bg-card"
		>
			<span aria-hidden className={`absolute inset-y-0 left-0 w-[2px] ${rule}`} />

			<CollapsibleTrigger
				render={
					<button
						type="button"
						className="group flex w-full items-start gap-3 py-3 pr-4 pl-5 text-left transition-colors hover:bg-muted/30"
					>
						<ChevronRight className="mt-1 size-3.5 shrink-0 text-subtle-foreground transition-transform group-data-[panel-open]:rotate-90" />
						<span className="min-w-0 flex-1">
							<span className="block text-[14px] font-semibold tracking-tight">{title}</span>

							{verbs ? (
								<span className="mt-1.5 flex flex-wrap items-center gap-2">
									{verbs.map((verb) => (
										<span
											key={verb}
											className={`rounded border px-1.5 py-px font-mono text-[10.5px] font-medium tracking-wide ${VERB_STYLE[verb]}`}
										>
											{verb}
										</span>
									))}
									<span className="font-mono text-[11.5px] text-muted-foreground">{path}</span>
								</span>
							) : (
								<span className="mt-1 block text-[11.5px] text-muted-foreground">{note}</span>
							)}
						</span>
					</button>
				}
			/>

			<CollapsibleContent>
				<div className="flex flex-col gap-4 border-t border-border py-4 pr-4 pl-5 text-[12.5px] leading-[1.65]">
					{children}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
