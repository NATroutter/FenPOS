import type { LucideIcon } from "lucide-react";
import {
	BookOpen,
	KeyRound,
	LayoutDashboard,
	ListOrdered,
	Printer,
	ScrollText,
	Server,
	Settings2,
	Wrench,
} from "lucide-react";

/**
 * The panel's navigation structure and page titles.
 *
 * Declared once here rather than duplicated across the sidebar and each page, so a route
 * cannot end up with a heading that disagrees with the sidebar entry that reached it.
 */

/** One navigable section. */
export interface NavItem {
	/** Route path, which is also the key used to find the active entry. */
	href: string;
	/** Sidebar label. */
	label: string;
	/** Heading shown at the top of the page, when it differs from the sidebar label. */
	title: string;
	/** Small text above the heading, naming the area the page belongs to. */
	kicker: string;
	icon: LucideIcon;
}

/** A labelled group of sections in the sidebar. */
export interface NavGroup {
	label: string;
	items: readonly NavItem[];
}

/**
 * Sidebar groups, in display order.
 *
 * Grouped by what the operator is doing rather than by data model: watching the system,
 * managing the hardware, or administering access.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
	{
		label: "Operations",
		items: [
			{
				href: "/dashboard",
				label: "Dashboard",
				title: "Dashboard",
				kicker: "Operations",
				icon: LayoutDashboard,
			},
			{ href: "/jobs", label: "Jobs", title: "Print jobs", kicker: "Operations", icon: ListOrdered },
			{ href: "/logs", label: "Logs", title: "Logs", kicker: "Operations", icon: ScrollText },
		],
	},
	{
		label: "Hardware",
		items: [
			{ href: "/agents", label: "Agents", title: "Agents", kicker: "Hardware", icon: Server },
			{ href: "/devices", label: "Devices", title: "Configured printers", kicker: "Hardware", icon: Printer },
			{ href: "/tools", label: "Tools", title: "Tools", kicker: "Hardware", icon: Wrench },
		],
	},
	{
		label: "Administration",
		items: [
			{ href: "/keys", label: "API keys", title: "API keys", kicker: "Administration", icon: KeyRound },
			{ href: "/settings", label: "Settings", title: "Settings", kicker: "Administration", icon: Settings2 },
			{ href: "/docs", label: "Docs", title: "API documentation", kicker: "Administration", icon: BookOpen },
		],
	},
];

/** Every section, flattened. */
export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/**
 * Finds the section a path belongs to.
 *
 * Matches on the path prefix so that nested routes, such as a device detail page, still
 * resolve to the section that owns them.
 *
 * @param pathname the current route
 * @returns the owning section, or undefined for a path outside the panel
 */
export function findNavItem(pathname: string): NavItem | undefined {
	return NAV_ITEMS.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
}
