"use client";

import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/**
 * One collapsible section of the reference.
 *
 * Open by default. The docs are read by someone who has a request failing right now, and a page
 * of closed headings makes them click through every one to find which section mentions their
 * error code — the browser's own find already does that job if the text is on the page.
 */
export function DocSection({ title, summary, children }: { title: string; summary: string; children: ReactNode }) {
	return (
		<Collapsible defaultOpen className="rounded-md border border-border">
			<CollapsibleTrigger
				render={
					<button type="button" className="group flex w-full items-start gap-3 px-4 py-3 text-left">
						<ChevronRight className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground transition-transform group-data-[panel-open]:rotate-90" />
						<span className="min-w-0 flex-1">
							<span className="block text-[13px] font-medium">{title}</span>
							<span className="mt-0.5 block text-[11.5px] text-muted-foreground">{summary}</span>
						</span>
					</button>
				}
			/>
			<CollapsibleContent>
				<div className="flex flex-col gap-3 border-t border-border px-4 py-4 text-[12.5px] leading-relaxed">
					{children}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
