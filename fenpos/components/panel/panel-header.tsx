"use client";

import { usePathname } from "next/navigation";
import { LiveToggle } from "@/components/panel/live-toggle";
import { Uptime } from "@/components/panel/uptime";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { findNavItem } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/**
 * The bar above each page: which section you are in, what it is for, and how long the server has
 * been up.
 *
 * Title and description come from the navigation table rather than from each page, so a heading
 * cannot disagree with the sidebar entry that led to it. The description lives here rather than
 * repeated at the top of each page: a heading that restated the title the bar had already given,
 * separated by a rule, was the first thing on every screen and told the operator nothing.
 */
/**
 * The height of the strip across the top of the panel, shared with the sidebar's own header.
 *
 * The two are separate elements in separate columns, each drawing its own bottom border, and the
 * eye reads those two borders as one line across the window — so a height that belongs to only one
 * of them shows up as a step at the seam. Fixed here rather than left to the content, because the
 * content is a title of one length beside a wordmark of another and they will never agree by
 * accident.
 *
 * `min-h` rather than `h`: below `md` the sidebar is an overlay sheet and no seam exists, which is
 * also where a long description is most likely to wrap onto a second line.
 */
export const HEADER_STRIP = "min-h-20";

export function PanelHeader({ startedAt }: { startedAt: number }) {
	const pathname = usePathname();
	const item = findNavItem(pathname);

	return (
		<header
			className={cn("flex flex-none flex-wrap items-center gap-4 border-b border-border px-6 py-3", HEADER_STRIP)}
		>
			<SidebarTrigger className="md:hidden" />

			<div className="min-w-[220px] flex-1">
				<h1 className="text-xl font-semibold tracking-tight">{item?.title ?? "FenPOS"}</h1>
				{item ? <p className="mt-1 max-w-3xl text-[12.5px] text-muted-foreground">{item.description}</p> : null}
			</div>

			<LiveToggle />

			<div className="text-right">
				<div className="text-[11px] font-medium text-subtle-foreground">Uptime</div>
				<Uptime startedAt={startedAt} />
			</div>
		</header>
	);
}
