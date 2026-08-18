"use client";

import { usePathname } from "next/navigation";
import { LiveToggle } from "@/components/panel/live-toggle";
import { Uptime } from "@/components/panel/uptime";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { findNavItem } from "@/lib/navigation";

/**
 * The bar above each page: which section you are in, and how long the server has been up.
 *
 * Title and kicker come from the navigation table rather than from each page, so a heading
 * cannot disagree with the sidebar entry that led to it.
 */
export function PanelHeader({ startedAt }: { startedAt: number }) {
	const pathname = usePathname();
	const item = findNavItem(pathname);

	return (
		<header className="flex flex-none flex-wrap items-center gap-4 border-b border-border px-6 py-4">
			<SidebarTrigger className="md:hidden" />

			<div className="min-w-[180px] flex-1">
				<div className="text-[11.5px] font-medium text-subtle-foreground">{item?.kicker ?? "FenPOS"}</div>
				<h1 className="mt-1 text-xl font-semibold tracking-tight">{item?.title ?? "FenPOS"}</h1>
			</div>

			<LiveToggle />

			<div className="text-right">
				<div className="text-[11px] font-medium text-subtle-foreground">Uptime</div>
				<Uptime startedAt={startedAt} />
			</div>
		</header>
	);
}
