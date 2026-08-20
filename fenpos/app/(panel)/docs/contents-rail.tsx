"use client";

import { DOC_REVEAL_EVENT } from "@/app/(panel)/docs/doc-section";

/**
 * The "On this page" rail.
 *
 * Ordinary anchors, so the jump, the URL and opening a link in a new tab all keep working without
 * being reimplemented. The click handler only announces which section was asked for, which the
 * sections listen for so a collapsed one opens rather than being scrolled to while still shut.
 *
 * A client component purely to carry that handler; the sections it lists are still declared once,
 * on the server, and passed in.
 */
export function ContentsRail({ sections }: { sections: readonly { id: string; title: string }[] }) {
	return (
		<nav aria-label="On this page" className="hidden xl:sticky xl:top-2 xl:block">
			<div className="text-[10.5px] font-medium tracking-[0.08em] text-subtle-foreground uppercase">On this page</div>
			<ul className="mt-2 flex flex-col gap-px border-l border-border">
				{sections.map((section) => (
					<li key={section.id}>
						<a
							href={`#${section.id}`}
							onClick={() => window.dispatchEvent(new CustomEvent(DOC_REVEAL_EVENT, { detail: section.id }))}
							className="-ml-px block border-l border-transparent py-1 pl-3 text-[12px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
						>
							{section.title}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}
